// tests/helpers/bridgeDataset.ts — a tiny hand-built ACCTMSTR/TRANS pair written byte by byte (never generated fixtures),
// with the expected values worked out by hand from docs/LEGACY-BEHAVIOUR.md in the comments below.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge, type Bridge, type CreateBridgeOptions, type ToolResult } from "../../src/bridge/createBridge.ts";

function pad(s: string, n: number): string {
  if (s.length > n) throw new Error(`"${s}" is longer than ${n}`);
  return s.padEnd(n, " ");
}

export type AcctSpec = {
  id: string;
  name?: string;
  status?: string;
  open?: string;
  balance?: string;
  /** Five COMP-3 bytes. */
  limit?: number[];
  rate?: string;
  tax?: string;
  memo?: string;
};

/** One 100-byte ACCTMSTR record: ID 9(10), NAME X(25), STATUS X, OPEN 9(6), BALANCE S9(9)V99, LIMIT COMP-3 (5), RATE 9V999,
 *  TAX-ID X(9), MEMO X(25), FILLER low-values X(4). */
export function acctRecord(s: AcctSpec): Buffer {
  const head = Buffer.from(
    s.id + pad(s.name ?? "", 25) + (s.status ?? "A") + (s.open ?? "980315") + (s.balance ?? "0000000000{"),
    "latin1",
  );
  const limit = Buffer.from(s.limit ?? [0x00, 0x01, 0x00, 0x00, 0x0c]);
  const tail = Buffer.from((s.rate ?? "0035") + pad(s.tax ?? "900000000", 9) + pad(s.memo ?? "", 25), "latin1");
  const rec = Buffer.concat([head, limit, tail, Buffer.alloc(4, 0x00)]);
  if (rec.length !== 100) throw new Error(`ACCTMSTR record is ${rec.length} bytes`);
  return rec;
}

export type TransSpec = { id: string; acct: string; date: string; type: string; amount: string; status: string; desc: string };

/** One 80-byte TRANS record: TRAN-ID 9(10), ACCT-ID 9(10), DATE 9(6), TYPE X, AMOUNT S9(7)V99, STATUS X, DESC X(30),
 *  FILLER X(13) spaces. */
export function transRecord(s: TransSpec): Buffer {
  const rec = Buffer.from(
    s.id + s.acct + s.date + s.type + s.amount + s.status + pad(s.desc, 30) + " ".repeat(13),
    "latin1",
  );
  if (rec.length !== 80) throw new Error(`TRANS record is ${rec.length} bytes`);
  return rec;
}

/**
 * ACCTMSTR (records are one-based source pointers):
 *  #1 0000000040 HARTLEY MERCANTILE LTD   A  balance 0000012345O = -123456, limit 000250000C = 250000, tax 900421234,
 *                                            interest trunc(-123456*35/12000) = trunc(-360.08) = -360
 *  #2 0000000041 SMITH  JONES  AND PARTNER S balance 0000001000{ = 10000 (25-char name, double spaces kept)
 *  #3 0000000042 XSTATUS CLOSED CO        X  balance 0000002000{ = 20000 (raw X => effective C)
 *  #4 0000000043 ROUNDING TRAP INDUSTRIES A  balance 0000987654C = 9876543, rate 0057 => interest 46913 (rounding: 46914)
 *  #5 0000000040 DUPLICATE SECOND COPY    A  balance 0000099999I (duplicate key: invisible, counted)
 *  #6 0000000044 HARBOR LIGHTS            C  open 000000 => null, balance 0000000500{ = 5000
 *  + 37-byte tail (key 0000000045) => skipped, not found
 * Winners: #1 #2 #3 #4 #6; balance total 9788087; status C => #3 #6 (25000); prefix HAR => #1 #6 (-118456).
 *
 * TRANS:
 *  #1 0000000001 acct 40 240131 D 00010000{ = 100000 O
 *  #2 0000000002 acct 40 240215 C 00005000{ =  50000 P
 *  #3 0000000003 acct 41 230228 D 00000250{ =   2500 O
 *  #4 0000000004 acct 40 240301 D 00000100{ =   1000 O
 *  #5 0000000005 acct 40 240302 D 00000200{ =   2000 P
 * acct 40 history: #1 #2 #4 #5, debit 103000, credit 50000.
 * AGING 2024-03-01 (open debits <= as_of): #1 30E/360 = 60+1-30 = 31 => 31-60; #3 = 360+30+1-28 = 363 => >90;
 * #4 = 0 => 0; #5 paid, #2 credit excluded. Count 3, amount 103500.
 */
export const ACCOUNTS: AcctSpec[] = [
  { id: "0000000040", name: "HARTLEY MERCANTILE LTD", balance: "0000012345O", limit: [0x00, 0x02, 0x50, 0x00, 0x0c], tax: "900421234", memo: "OVERDRAWN - REVIEW" },
  { id: "0000000041", name: "SMITH  JONES  AND PARTNER", status: "S", balance: "0000001000{", tax: "900000041" },
  { id: "0000000042", name: "XSTATUS CLOSED CO", status: "X", balance: "0000002000{", tax: "900000042" },
  { id: "0000000043", name: "ROUNDING TRAP INDUSTRIES", open: "050101", balance: "0000987654C", rate: "0057", tax: "900000043" },
  { id: "0000000040", name: "DUPLICATE SECOND COPY", balance: "0000099999I", tax: "900009999" },
  { id: "0000000044", name: "HARBOR LIGHTS", status: "C", open: "000000", balance: "0000000500{", tax: "900000044" },
];

export const TAIL_KEY = "0000000045";

export const TRANSACTIONS: TransSpec[] = [
  { id: "0000000001", acct: "0000000040", date: "240131", type: "D", amount: "00010000{", status: "O", desc: "INVOICE 1" },
  { id: "0000000002", acct: "0000000040", date: "240215", type: "C", amount: "00005000{", status: "P", desc: "PAYMENT" },
  { id: "0000000003", acct: "0000000041", date: "230228", type: "D", amount: "00000250{", status: "O", desc: "FEE" },
  { id: "0000000004", acct: "0000000040", date: "240301", type: "D", amount: "00000100{", status: "O", desc: "CHARGE" },
  { id: "0000000005", acct: "0000000040", date: "240302", type: "D", amount: "00000200{", status: "P", desc: "CHARGE PAID" },
];

export function acctFileBytes(accounts: AcctSpec[] = ACCOUNTS): Buffer {
  const tail = acctRecord({ id: TAIL_KEY, name: "TRUNCATED TAIL RECORD" }).subarray(0, 37);
  return Buffer.concat([...accounts.map(acctRecord), tail]);
}

export function transFileBytes(transactions: TransSpec[] = TRANSACTIONS): Buffer {
  return Buffer.concat(transactions.map(transRecord));
}

/** Write a dataset into a fresh temp directory and return its path. */
export function writeDataset(acct: Buffer = acctFileBytes(), trans: Buffer = transFileBytes()): string {
  const dir = mkdtempSync(join(tmpdir(), "lmb-bridge-"));
  writeFileSync(join(dir, "ACCTMSTR.DAT"), acct);
  writeFileSync(join(dir, "TRANS.DAT"), trans);
  return dir;
}

export function testBridge(extra: Omit<CreateBridgeOptions, "dataRoot"> = {}, dataRoot: string = writeDataset()): Bridge {
  return createBridge({ dataRoot, ...extra });
}

export type OkResult = Extract<ToolResult, { ok: true }>;
export type ErrResult = Extract<ToolResult, { ok: false }>;

export function expectOk(r: ToolResult): OkResult {
  if (!r.ok) throw new Error(`expected success, got ${r.error.code}: ${r.error.message}`);
  return r;
}

export function expectErr(r: ToolResult): ErrResult {
  if (r.ok) throw new Error("expected an error result, got success");
  return r;
}

/** UTF-8 bytes of the complete result exactly as the bridge measures it against the cap. */
export function resultBytes(r: OkResult): number {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: r.text }], structuredContent: r.structured }), "utf8");
}

export type Row = { source: string } & Record<string, unknown>;

export function rowsOf(r: OkResult): Row[] {
  const data = r.structured["data"];
  if (!Array.isArray(data)) throw new Error("data is not an array");
  return data as Row[];
}
