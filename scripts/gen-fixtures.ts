// scripts/gen-fixtures.ts — seeded fixture generator (freeze 1B input).
// Builds ACCTMSTR.DAT (1,000 x 100 bytes + 37-byte tail) and TRANS.DAT (8,000 x 80 bytes) in two views (legacy = canonical/attacked,
// legacy-clean) plus MANIFEST.json, planting every trap record from fixtures/plants.json byte for byte. It encodes on its own and
// never imports anything under src/ (independence boundary, PLAN.md section 4). Deterministic: mulberry32 only, no clock.
//
// Usage: node --experimental-strip-types scripts/gen-fixtures.ts [--out <dir>]   (default <repo>/fixtures)

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GENERATOR_VERSION = "1.0.0";
const ACCT_RECORDS = 1000;
const TRANS_RECORDS = 8000;

type FieldType = "alnum" | "zoned" | "packed" | "date_yymmdd" | "lowvalues";

interface LayoutField {
  name: string;
  offset: number;
  length: number;
  type: FieldType;
  digits?: number;
  scale: number;
  signed: boolean;
}

interface Layout {
  record: string;
  recordLength: number;
  fields: LayoutField[];
}

type RawValue = string | { hex: string };
type RawFields = Record<string, RawValue>;

interface PlantRecord {
  record: number;
  fields: RawFields;
}

interface PlantTrans {
  tran_record: number;
  fields: RawFields;
}

interface Injection {
  id: string;
  record: number;
  field: string;
  record_offset: number;
  file_offset: number;
  length: number;
  attack_text: string;
  clean_text: string;
}

interface Plants {
  generator: { seed: number; prng: string; version: string };
  acctmstr: {
    record_length: number;
    complete_records: number;
    id_offset: number;
    defaults: RawFields;
    records: PlantRecord[];
    tail: { file_offset: number; length: number; text: string };
  };
  trans: {
    record_length: number;
    complete_records: number;
    records: PlantTrans[];
    series: { account_id: string; count: number; stride: number }[];
  };
  injections: Injection[];
}

// ---------------------------------------------------------------------------------------------------------------------------
// Seeded PRNG (mulberry32). Integer-only draws: no floating point enters the fixture bytes.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** Uniform-ish integer in [0, n). Modulo bias is irrelevant for synthetic data. */
  int(n: number): number {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Rng.int: bad bound ${n}`);
    return this.next() % n;
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error("Rng.pick: empty list");
    return item;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Encoders (independent of src/fixedwidth by design).

const POSITIVE_OVERPUNCH = "{ABCDEFGHI";
const NEGATIVE_OVERPUNCH = "}JKLMNOPQR";

function ascii(text: string, what: string): Buffer {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) throw new Error(`${what}: non-printable or non-ASCII character at ${i}`);
  }
  return Buffer.from(text, "latin1");
}

function encodeText(text: string, width: number, what: string): Buffer {
  if (text.length > width) throw new Error(`${what}: "${text}" is longer than ${width}`);
  return ascii(text.padEnd(width, " "), what);
}

/** Zoned display digits; signed fields get a trailing overpunch on the last digit. */
function encodeZoned(minor: bigint, digits: number, signed: boolean, what: string): Buffer {
  const negative = minor < 0n;
  if (negative && !signed) throw new Error(`${what}: negative value for unsigned field`);
  const body = (negative ? -minor : minor).toString();
  if (body.length > digits) throw new Error(`${what}: ${minor} does not fit ${digits} digits`);
  const padded = body.padStart(digits, "0");
  if (!signed) return ascii(padded, what);
  const last = Number(padded.charAt(digits - 1));
  const punch = (negative ? NEGATIVE_OVERPUNCH : POSITIVE_OVERPUNCH).charAt(last);
  return ascii(padded.slice(0, digits - 1) + punch, what);
}

/** COMP-3: digit nibbles then sign nibble (C positive, D negative); length = floor(digits/2)+1 bytes. */
function encodePacked(minor: bigint, digits: number, length: number, what: string): Buffer {
  if (length !== Math.floor(digits / 2) + 1) throw new Error(`${what}: packed length ${length} != floor(${digits}/2)+1`);
  const negative = minor < 0n;
  const body = (negative ? -minor : minor).toString();
  if (body.length > digits) throw new Error(`${what}: ${minor} does not fit ${digits} digits`);
  const hex = body.padStart(length * 2 - 1, "0") + (negative ? "D" : "C");
  return Buffer.from(hex, "hex");
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const base = DAYS_IN_MONTH[month - 1];
  if (base === undefined) throw new Error(`bad month ${month}`);
  return month === 2 && isLeap(year) ? 29 : base;
}

/** YYMMDD with pivot 50: only years 1950..2049 are representable. */
function encodeDate(year: number, month: number, day: number, what: string): Buffer {
  if (year < 1950 || year > 2049) throw new Error(`${what}: year ${year} outside the pivot-50 window`);
  if (day < 1 || day > daysInMonth(year, month)) throw new Error(`${what}: invalid date ${year}-${month}-${day}`);
  const yy = String(year % 100).padStart(2, "0");
  return ascii(yy + String(month).padStart(2, "0") + String(day).padStart(2, "0"), what);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ---------------------------------------------------------------------------------------------------------------------------
// Record assembly driven by the layout JSON (offsets come from the layout; the generator does not decode).

type FieldBytes = Map<string, Buffer>;

function fieldByName(layout: Layout, name: string): LayoutField {
  const field = layout.fields.find((f) => f.name === name);
  if (field === undefined) throw new Error(`${layout.record}: no field ${name}`);
  return field;
}

function checkLayout(layout: Layout): void {
  let expected = 0;
  for (const f of layout.fields) {
    if (f.offset !== expected) throw new Error(`${layout.record}.${f.name}: offset ${f.offset}, expected ${expected}`);
    expected += f.length;
  }
  if (expected !== layout.recordLength) throw new Error(`${layout.record}: lengths sum to ${expected}, not ${layout.recordLength}`);
}

/** Plant value → exact field bytes. alnum strings are space-padded; everything else must already be exact width. */
function rawBytes(layout: Layout, name: string, value: RawValue): Buffer {
  const field = fieldByName(layout, name);
  const what = `${layout.record}.${name}`;
  let bytes: Buffer;
  if (typeof value === "object") {
    bytes = Buffer.from(value.hex, "hex");
  } else if (field.type === "alnum") {
    bytes = encodeText(value, field.length, what);
  } else {
    bytes = ascii(value, what);
  }
  if (bytes.length !== field.length) throw new Error(`${what}: planted ${bytes.length} bytes, field is ${field.length}`);
  return bytes;
}

function assemble(layout: Layout, values: FieldBytes, what: string): Buffer {
  const record = Buffer.alloc(layout.recordLength, 0x20);
  for (const f of layout.fields) {
    const bytes = values.get(f.name);
    if (bytes === undefined) throw new Error(`${what}: missing ${f.name}`);
    if (bytes.length !== f.length) throw new Error(`${what}: ${f.name} is ${bytes.length} bytes, expected ${f.length}`);
    bytes.copy(record, f.offset);
  }
  return record;
}

function plantedRecord(layout: Layout, defaults: RawFields, fields: RawFields, what: string): Buffer {
  const values: FieldBytes = new Map();
  for (const [name, value] of Object.entries({ ...defaults, ...fields })) values.set(name, rawBytes(layout, name, value));
  return assemble(layout, values, what);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Generated (unplanted) content. Vocabulary avoids every planted name prefix (ADMI, ZEPHYR, DUPLICATE, PIVOT, ...).

const NAME_FIRST = [
  "ACME", "BAYVIEW", "CEDAR", "DELTA", "EAGLE", "FALCON", "GRANITE", "HARBOR", "IRON", "JUNIPER", "KESTREL", "LAUREL", "MAPLE",
  "NORTHGATE", "OAKWOOD", "PINECREST", "QUARRY", "REDWOOD", "SUMMIT", "TIMBER", "UNION", "VALLEY", "WILLOW", "YARROW",
] as const;
const NAME_SECOND = [
  "BAKERY", "CONSULTING", "DESIGN", "ELECTRIC", "FARMS", "FOODS", "HARDWARE", "HOLDINGS", "LOGISTICS", "MARINE", "MOTORS",
  "PLUMBING", "PRINTING", "REALTY", "SUPPLY", "TEXTILES", "TOOLING", "TRADING", "TRAVEL", "VENTURES",
] as const;
const NAME_SUFFIX = ["CO", "INC", "LLC", "LTD", "GROUP", "& SONS"] as const;
const MEMOS = [
  "STATEMENT BY POST", "PAPERLESS", "VIP CUSTOMER", "CALL BEFORE 5PM", "ADDRESS UPDATED", "JOINT ACCOUNT", "DIRECT DEBIT ON FILE",
  "OVERDRAFT REVIEWED",
] as const;
const DESCS = [
  "CARD PURCHASE", "ATM WITHDRAWAL", "PAYROLL DEPOSIT", "WIRE TRANSFER IN", "WIRE TRANSFER OUT", "UTILITY BILL", "LOAN PAYMENT",
  "SERVICE FEE", "INTEREST CREDIT", "CHEQUE DEPOSIT", "STANDING ORDER", "REFUND",
] as const;

function generatedAccount(layout: Layout, rng: Rng, accountId: string): Buffer {
  const v: FieldBytes = new Map();
  v.set("ACCT-ID", ascii(accountId, "ACCT-ID"));

  const name = `${rng.pick(NAME_FIRST)} ${rng.pick(NAME_SECOND)} ${rng.pick(NAME_SUFFIX)}`.slice(0, 25);
  v.set("ACCT-NAME", encodeText(name, 25, "ACCT-NAME"));

  const s = rng.int(100);
  v.set("ACCT-STATUS", ascii(s < 70 ? "A" : s < 82 ? "S" : s < 95 ? "C" : "X", "ACCT-STATUS"));

  if (rng.int(100) < 3) {
    v.set("OPEN-DATE", ascii("000000", "OPEN-DATE"));
  } else {
    const year = 1960 + rng.int(65); // 1960..2024
    const month = 1 + rng.int(12);
    const day = 1 + rng.int(daysInMonth(year, month));
    v.set("OPEN-DATE", encodeDate(year, month, day, "OPEN-DATE"));
  }

  const magnitude = BigInt(rng.int(5_000_000));
  const balance = rng.int(10) === 0 ? -magnitude : magnitude;
  const bal = fieldByName(layout, "BALANCE");
  v.set("BALANCE", encodeZoned(balance, bal.digits ?? bal.length, true, "BALANCE"));

  const lim = fieldByName(layout, "CREDIT-LIMIT");
  v.set("CREDIT-LIMIT", encodePacked(BigInt(rng.int(1000)) * 10000n, lim.digits ?? 9, lim.length, "CREDIT-LIMIT"));

  v.set("RATE", encodeZoned(BigInt(rng.int(251)), 4, false, "RATE"));
  v.set("TAX-ID", ascii("9" + String(rng.int(100_000_000)).padStart(8, "0"), "TAX-ID"));
  v.set("MEMO", encodeText(rng.int(4) === 0 ? rng.pick(MEMOS) : "", 25, "MEMO"));
  v.set("FILLER", Buffer.alloc(4, 0x00));
  return assemble(layout, v, `ACCTMSTR generated ${accountId}`);
}

/** Day offset from 2023-01-01 → [year, month, day]. */
function dateFromOffset(offset: number): [number, number, number] {
  let year = 2023;
  let month = 1;
  let rest = offset;
  for (;;) {
    const dim = daysInMonth(year, month);
    if (rest < dim) return [year, month, rest + 1];
    rest -= dim;
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
}

function transBase(t: number): string {
  return String(1_000_000_000 + t).padStart(10, "0");
}

function generatedTrans(layout: Layout, rng: Rng, t: number, accountPool: readonly string[]): Buffer {
  const v: FieldBytes = new Map();
  v.set("TRAN-ID", ascii(transBase(t), "TRAN-ID"));
  v.set("ACCT-ID", ascii(rng.pick(accountPool), "ACCT-ID"));
  const [y, m, d] = dateFromOffset(rng.int(731)); // 2023-01-01 .. 2024-12-31
  v.set("TRAN-DATE", encodeDate(y, m, d, "TRAN-DATE"));
  v.set("TRAN-TYPE", ascii(rng.int(10) < 7 ? "D" : "C", "TRAN-TYPE"));
  v.set("AMOUNT", encodeZoned(BigInt(100 + rng.int(500_000)), 9, true, "AMOUNT"));
  v.set("TRAN-STATUS", ascii(rng.int(10) < 6 ? "O" : "P", "TRAN-STATUS"));
  v.set("DESC", encodeText(rng.pick(DESCS), 30, "DESC"));
  v.set("FILLER", Buffer.alloc(13, 0x20));
  return assemble(layout, v, `TRANS generated #${t}`);
}

/** Series rules transcribed from plants.json (zephyr_paged_accounts, paged_history_120). */
function zephyrRecord(layout: Layout, j: number): Buffer {
  const r = 800 + j;
  const fields: RawFields = {
    "ACCT-ID": String(r + 39).padStart(10, "0"),
    "ACCT-NAME": `ZEPHYR TRADING ${pad2(j)}`,
    "ACCT-STATUS": j <= 60 ? "A" : "S",
    "OPEN-DATE": "150301",
    "CREDIT-LIMIT": { hex: "000500000C" },
    "RATE": "0020",
    "TAX-ID": `9008000${pad2(j)}`,
    "MEMO": "",
    "FILLER": { hex: "00000000" },
  };
  const values: FieldBytes = new Map();
  for (const [name, value] of Object.entries(fields)) values.set(name, rawBytes(layout, name, value));
  values.set("BALANCE", encodeZoned(BigInt(j) * 10000n, 11, true, "BALANCE"));
  return assemble(layout, values, `ACCTMSTR zephyr ${j}`);
}

function historySeriesRecord(layout: Layout, accountId: string, k: number, stride: number): Buffer {
  const t = stride * k;
  const month = Math.ceil(k / 10);
  const day = 3 * ((k - 1) % 10) + 1;
  const debit = k % 2 === 1;
  const v: FieldBytes = new Map();
  v.set("TRAN-ID", ascii(transBase(t), "TRAN-ID"));
  v.set("ACCT-ID", ascii(accountId, "ACCT-ID"));
  v.set("TRAN-DATE", encodeDate(2024, month, day, "TRAN-DATE"));
  v.set("TRAN-TYPE", ascii(debit ? "D" : "C", "TRAN-TYPE"));
  v.set("AMOUNT", encodeZoned(BigInt(k) * (debit ? 100n : 50n), 9, true, "AMOUNT"));
  v.set("TRAN-STATUS", ascii("P", "TRAN-STATUS"));
  v.set("DESC", encodeText(`PAGED HISTORY SERIES LINE ${String(k).padStart(3, "0")}`, 30, "DESC"));
  v.set("FILLER", Buffer.alloc(13, 0x20));
  return assemble(layout, v, `TRANS series k=${k}`);
}

// ---------------------------------------------------------------------------------------------------------------------------

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path).toString("utf8")) as T;
}

function parseOut(argv: readonly string[], repoRoot: string): string {
  const i = argv.indexOf("--out");
  if (i === -1) return join(repoRoot, "fixtures");
  const dir = argv[i + 1];
  if (dir === undefined || dir.startsWith("--")) throw new Error("--out needs a directory");
  return resolve(dir);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const outDir = parseOut(process.argv.slice(2), repoRoot);

  const acctLayout = readJson<Layout>(join(repoRoot, "fixtures", "layouts", "acctmstr.json"));
  const transLayout = readJson<Layout>(join(repoRoot, "fixtures", "layouts", "trans.json"));
  const plants = readJson<Plants>(join(repoRoot, "fixtures", "plants.json"));
  checkLayout(acctLayout);
  checkLayout(transLayout);
  if (acctLayout.recordLength !== plants.acctmstr.record_length || transLayout.recordLength !== plants.trans.record_length) {
    throw new Error("layout and plants disagree on record length");
  }
  if (plants.acctmstr.complete_records !== ACCT_RECORDS || plants.trans.complete_records !== TRANS_RECORDS) {
    throw new Error("plants record counts differ from the generator constants");
  }

  const rng = new Rng(plants.generator.seed);
  const acctLen = acctLayout.recordLength;
  const transLen = transLayout.recordLength;

  // --- ACCTMSTR -----------------------------------------------------------------------------------------------------------
  const planted = new Map<number, Buffer>();
  for (const p of plants.acctmstr.records) {
    planted.set(p.record, plantedRecord(acctLayout, plants.acctmstr.defaults, p.fields, `ACCTMSTR#${p.record}`));
  }
  for (let j = 1; j <= 61; j++) planted.set(800 + j, zephyrRecord(acctLayout, j));

  const tail = plants.acctmstr.tail;
  const acct = Buffer.alloc(ACCT_RECORDS * acctLen + tail.length);
  const accountPool: string[] = [];
  for (let r = 1; r <= ACCT_RECORDS; r++) {
    let rec = planted.get(r);
    if (rec === undefined) {
      const id = String(r + plants.acctmstr.id_offset).padStart(10, "0");
      rec = generatedAccount(acctLayout, rng, id);
      accountPool.push(id);
    }
    rec.copy(acct, (r - 1) * acctLen);
  }
  const tailBytes = ascii(tail.text, "ACCTMSTR tail");
  if (tailBytes.length !== tail.length || tail.file_offset !== ACCT_RECORDS * acctLen) throw new Error("tail plant inconsistent");
  tailBytes.copy(acct, tail.file_offset);

  // --- TRANS --------------------------------------------------------------------------------------------------------------
  const plantedTrans = new Map<number, Buffer>();
  for (const p of plants.trans.records) {
    plantedTrans.set(p.tran_record, plantedRecord(transLayout, { FILLER: "" }, p.fields, `TRANS#${p.tran_record}`));
  }
  for (const s of plants.trans.series) {
    for (let k = 1; k <= s.count; k++) {
      const t = s.stride * k;
      if (plantedTrans.has(t)) throw new Error(`TRANS#${t} planted twice`);
      plantedTrans.set(t, historySeriesRecord(transLayout, s.account_id, k, s.stride));
    }
  }
  const trans = Buffer.alloc(TRANS_RECORDS * transLen);
  for (let t = 1; t <= TRANS_RECORDS; t++) {
    const rec = plantedTrans.get(t) ?? generatedTrans(transLayout, rng, t, accountPool);
    rec.copy(trans, (t - 1) * transLen);
  }

  // --- Clean view: replace only the named injection ranges ---------------------------------------------------------------
  const acctClean = Buffer.from(acct);
  for (const inj of plants.injections) {
    const field = fieldByName(acctLayout, inj.field);
    const at = (inj.record - 1) * acctLen + field.offset;
    if (at !== inj.file_offset || field.offset !== inj.record_offset || field.length !== inj.length) {
      throw new Error(`${inj.id}: offsets disagree with the layout`);
    }
    const attack = encodeText(inj.attack_text, inj.length, inj.id);
    const clean = encodeText(inj.clean_text, inj.length, inj.id);
    if (inj.attack_text.length !== inj.length || inj.clean_text.length !== inj.length) {
      throw new Error(`${inj.id}: attack and clean text must be exactly ${inj.length} characters`);
    }
    if (!acct.subarray(at, at + inj.length).equals(attack)) throw new Error(`${inj.id}: planted bytes differ from attack_text`);
    clean.copy(acctClean, at);
  }
  for (let i = 0; i < acct.length; i++) {
    if (acct[i] === acctClean[i]) continue;
    const inRange = plants.injections.some((inj) => i >= inj.file_offset && i < inj.file_offset + inj.length);
    if (!inRange) throw new Error(`views differ outside the injection ranges at byte ${i}`);
  }

  // --- Write views and manifest (bytes only) -----------------------------------------------------------------------------
  const outputs: { view: string; path: string; buf: Buffer }[] = [
    { view: "attacked", path: "legacy/ACCTMSTR.DAT", buf: acct },
    { view: "attacked", path: "legacy/TRANS.DAT", buf: trans },
    { view: "clean", path: "legacy-clean/ACCTMSTR.DAT", buf: acctClean },
    { view: "clean", path: "legacy-clean/TRANS.DAT", buf: trans },
  ];
  for (const o of outputs) {
    const target = join(outDir, ...o.path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, o.buf);
  }

  const manifest = {
    status: "generated",
    generator: { script: "scripts/gen-fixtures.ts", version: GENERATOR_VERSION, prng: "mulberry32", seed: plants.generator.seed },
    behaviour_version: 1,
    views: { attacked: "legacy", clean: "legacy-clean" },
    files: outputs.map((o) => ({ view: o.view, path: o.path, bytes: o.buf.length, sha256: sha256(o.buf) })),
    injection_ranges: plants.injections.map((inj) => ({
      id: inj.id,
      file: "ACCTMSTR.DAT",
      file_offset: inj.file_offset,
      length: inj.length,
    })),
  };
  writeFileSync(join(outDir, "MANIFEST.json"), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));

  for (const f of manifest.files) process.stdout.write(`${f.path} ${f.bytes} ${f.sha256}\n`);
}

main();
