// src/bridge/store.ts — loads ACCTMSTR.DAT and TRANS.DAT once (raw bytes, via mcpkit's confined openFixedFile), checks each
// layout against its copybook, splits complete records from the skipped tail, decodes every record field by field through
// BridgeOps, and indexes keys with the duplicate rule (first physical record wins by default). Records stay in physical order.
// A record that cannot be decoded is kept as a defect slot; a tool that reaches one fails with `internal` (never a guess).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkLayoutAgainstCopybook, parseCopybook } from "../fixedwidth/copybook.ts";
import { FixedWidthError, LayoutMismatch } from "../fixedwidth/errors.ts";
import { loadLayoutFile, type Layout, type LayoutField } from "../fixedwidth/layout.ts";
import { decodeDigits } from "../fixedwidth/money.ts";
import { ToolError } from "../mcpkit/errors.ts";
import { logErr } from "../mcpkit/logger.ts";
import { openFixedFile, resolveDataRoot, type DataFileName } from "../mcpkit/paths.ts";
import type { BridgeOps, EffectiveStatus } from "./ops.ts";

export type AccountRec = {
  /** One-based physical record number (source pointer ACCTMSTR#record). */
  record: number;
  account_id: string;
  name: string;
  status: EffectiveStatus;
  open_date: string | null;
  balance_minor: bigint;
  credit_limit_minor: bigint;
  rate_thousandths: bigint;
  /** Raw (unmasked) tax id; masked only at the output boundary. */
  tax_id: string;
  memo: string;
};

export type TransRec = {
  /** One-based physical record number (source pointer TRANS#record). */
  record: number;
  tran_id: string;
  account_id: string;
  date: string;
  type: "D" | "C";
  amount_minor: bigint;
  status: "O" | "P";
  desc: string;
};

export type Slot<T> = { ok: true; rec: T } | { ok: false; record: number; reason: string };

export type FileDiagnostics = { records_read: number; skipped_tail_bytes: number; duplicate_keys: number };

export type DataFile<T> = {
  name: DataFileName;
  /** Source-pointer prefix: "ACCTMSTR" or "TRANS". */
  label: "ACCTMSTR" | "TRANS";
  layout: Layout;
  /** One slot per decoded record, zero-based physical index. */
  slots: Slot<T>[];
  /** Key of each slot (null when the key itself could not be read). */
  keys: Array<string | null>;
  /** key -> zero-based index of the representing record. */
  winner: Map<string, number>;
  diagnostics: FileDiagnostics;
  sha256: string;
};

export type Store = {
  accounts: DataFile<AccountRec>;
  transactions: DataFile<TransRec>;
  /** sha256 over both files' digests; binds cursors to the exact bytes served. */
  fixtureDigest: string;
};

/** A record that decodes but breaks a legacy rule outside the copybook (unknown status/type code, forbidden null date). */
class RecordDefect extends Error {}

const COPYBOOK_NAME_RE = /^[A-Za-z0-9_-]+\.cpy$/;

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Read a layout JSON and check it against its copybook (both are source contracts under the fixtures directory). */
export function readLayout(fixturesDir: string, fileName: "acctmstr.json" | "trans.json"): Layout {
  const layout = loadLayoutFile(join(fixturesDir, "layouts", fileName));
  if (!COPYBOOK_NAME_RE.test(layout.copybook)) throw new LayoutMismatch(`${layout.record}: bad copybook name`);
  const copybook = readFileSync(join(fixturesDir, "copybooks", layout.copybook), "utf8");
  checkLayoutAgainstCopybook(layout, parseCopybook(copybook));
  return layout;
}

function fieldOf(layout: Layout, name: string): LayoutField {
  const f = layout.fields.find((x) => x.name === name);
  if (f === undefined) throw new LayoutMismatch(`${layout.record}: field ${name} missing from layout`);
  return f;
}

/** Bytes of physical record `index`; a record that runs past the end of the file is space-padded (only reachable when a
 *  non-default splitRecords decodes the tail). */
function recordBytes(buf: Buffer, index: number, len: number): Buffer {
  const start = index * len;
  const slice = buf.subarray(start, start + len);
  if (slice.length === len) return slice;
  const padded = Buffer.alloc(len, 0x20);
  slice.copy(padded);
  return padded;
}

function oneChar(rec: Buffer, f: LayoutField): string {
  return rec.toString("latin1", f.offset, f.offset + 1);
}

function readKey(rec: Buffer, f: LayoutField): string | null {
  try {
    return decodeDigits(rec, f.offset, f.length);
  } catch {
    return null;
  }
}

function decodeDate(ops: BridgeOps, rec: Buffer, f: LayoutField): string | null {
  const iso = ops.decodeDate(rec, f.offset);
  if (iso === null && f.dateWindow?.never !== "000000") throw new RecordDefect(`${f.name}: 000000 is not allowed`);
  return iso;
}

function text(ops: BridgeOps, rec: Buffer, f: LayoutField): string {
  return ops.decodeText(rec, f.offset, f.length, f.name);
}

const isTranType = (s: string): s is TransRec["type"] => s === "D" || s === "C";
const isTranStatus = (s: string): s is TransRec["status"] => s === "O" || s === "P";

function slot<T>(record: number, decode: () => T): Slot<T> {
  try {
    return { ok: true, rec: decode() };
  } catch (e) {
    if (e instanceof FixedWidthError || e instanceof RecordDefect) {
      const reason = e instanceof FixedWidthError ? `${e.code}: ${e.message}` : e.message;
      return { ok: false, record, reason };
    }
    throw e;
  }
}

function loadFile<T>(
  ops: BridgeOps,
  root: string,
  name: DataFileName,
  label: "ACCTMSTR" | "TRANS",
  layout: Layout,
  keyField: LayoutField,
  decode: (rec: Buffer, record: number) => T,
): DataFile<T> {
  const buf = openFixedFile(root, name);
  const split = ops.splitRecords(buf.length, layout.recordLength);
  const slots: Slot<T>[] = [];
  const keys: Array<string | null> = [];
  for (let i = 0; i < split.records; i++) {
    const rec = recordBytes(buf, i, layout.recordLength);
    keys.push(readKey(rec, keyField));
    slots.push(slot(i + 1, () => decode(rec, i + 1)));
  }
  const { winner, duplicateKeys } = ops.pickWinners(keys);
  for (const s of slots) if (!s.ok) logErr(`${label}#${s.record} is defective: ${s.reason}`);
  return {
    name,
    label,
    layout,
    slots,
    keys,
    winner,
    diagnostics: { records_read: split.records, skipped_tail_bytes: split.skippedTailBytes, duplicate_keys: duplicateKeys },
    sha256: sha256Hex(buf),
  };
}

export function loadStore(opts: { dataRoot: string; fixturesDir: string; ops: BridgeOps }): Store {
  const { ops } = opts;
  const root = resolveDataRoot(opts.dataRoot);
  const acctLayout = readLayout(opts.fixturesDir, "acctmstr.json");
  const transLayout = readLayout(opts.fixturesDir, "trans.json");

  const a = {
    id: fieldOf(acctLayout, "ACCT-ID"),
    name: fieldOf(acctLayout, "ACCT-NAME"),
    status: fieldOf(acctLayout, "ACCT-STATUS"),
    open: fieldOf(acctLayout, "OPEN-DATE"),
    balance: fieldOf(acctLayout, "BALANCE"),
    limit: fieldOf(acctLayout, "CREDIT-LIMIT"),
    rate: fieldOf(acctLayout, "RATE"),
    tax: fieldOf(acctLayout, "TAX-ID"),
    memo: fieldOf(acctLayout, "MEMO"),
  };
  const t = {
    id: fieldOf(transLayout, "TRAN-ID"),
    acct: fieldOf(transLayout, "ACCT-ID"),
    date: fieldOf(transLayout, "TRAN-DATE"),
    type: fieldOf(transLayout, "TRAN-TYPE"),
    amount: fieldOf(transLayout, "AMOUNT"),
    status: fieldOf(transLayout, "TRAN-STATUS"),
    desc: fieldOf(transLayout, "DESC"),
  };

  const accounts = loadFile<AccountRec>(ops, root, "ACCTMSTR.DAT", "ACCTMSTR", acctLayout, a.id, (rec, record) => {
    const rawStatus = oneChar(rec, a.status);
    const status = ops.effectiveStatus(rawStatus);
    if (status === null) throw new RecordDefect("unknown ACCT-STATUS code");
    return {
      record,
      account_id: decodeDigits(rec, a.id.offset, a.id.length),
      name: text(ops, rec, a.name),
      status,
      open_date: decodeDate(ops, rec, a.open),
      balance_minor: ops.decodeZoned(rec, a.balance.offset, a.balance.length, a.balance.signed),
      credit_limit_minor: ops.decodePacked(rec, a.limit.offset, a.limit.length),
      rate_thousandths: ops.decodeZoned(rec, a.rate.offset, a.rate.length, a.rate.signed),
      tax_id: text(ops, rec, a.tax),
      memo: text(ops, rec, a.memo),
    };
  });

  const transactions = loadFile<TransRec>(ops, root, "TRANS.DAT", "TRANS", transLayout, t.id, (rec, record) => {
    const type = oneChar(rec, t.type);
    const status = oneChar(rec, t.status);
    if (!isTranType(type)) throw new RecordDefect("unknown TRAN-TYPE code");
    if (!isTranStatus(status)) throw new RecordDefect("unknown TRAN-STATUS code");
    const date = decodeDate(ops, rec, t.date);
    if (date === null) throw new RecordDefect("TRAN-DATE is never");
    return {
      record,
      tran_id: decodeDigits(rec, t.id.offset, t.id.length),
      account_id: decodeDigits(rec, t.acct.offset, t.acct.length),
      date,
      type,
      amount_minor: ops.decodeZoned(rec, t.amount.offset, t.amount.length, t.amount.signed),
      status,
      desc: text(ops, rec, t.desc),
    };
  });

  const fixtureDigest = sha256Hex(`ACCTMSTR.DAT:${accounts.sha256}\nTRANS.DAT:${transactions.sha256}\n`);
  return { accounts, transactions, fixtureDigest };
}

/** True when physical record `index` represents its key. An unreadable key is a defect, never a known duplicate loser. */
export function isWinner<T>(file: DataFile<T>, index: number): boolean {
  const key = file.keys[index];
  if (key === undefined) throw new ToolError("internal", `${file.label} record index out of range`);
  if (key === null) throw new ToolError("internal", `${file.label}#${index + 1} is a defective record`);
  return file.winner.get(key) === index;
}

/** The decoded record at `index`, or ToolError internal for a defect (the reason goes to stderr only). */
export function recordAt<T>(file: DataFile<T>, index: number): T {
  const s = file.slots[index];
  if (s === undefined) throw new ToolError("internal", `${file.label} record index out of range`);
  if (!s.ok) throw new ToolError("internal", `${file.label}#${s.record} is a defective record`);
  return s.rec;
}
