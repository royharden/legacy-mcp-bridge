// LEGACY01 file section: record descriptions (hand-transcribed from the ACCTMSTR / TRANS copybooks), data
// file location, and the record-at-a-time scan that applies first-key-wins and skips a truncated tail.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeKey,
  decodeText,
  decodeZonedUnsigned,
  decodeZonedSigned,
  decodePacked,
  decodeYYMMDD,
} from "./decode.mjs";

// ---- ACCTMSTR, record length 100 (zero-based offsets) ----
export const ACCT_RECLEN = 100;
export const ACCT_ID_OFF = 0;          // 9(10)
export const ACCT_ID_LEN = 10;
export const ACCT_NAME_OFF = 10;       // X(25)
export const ACCT_NAME_LEN = 25;
export const ACCT_STATUS_OFF = 35;     // X
export const ACCT_STATUS_LEN = 1;
export const ACCT_OPEN_OFF = 36;       // 9(6) YYMMDD
export const ACCT_OPEN_LEN = 6;
export const ACCT_BAL_OFF = 42;        // S9(9)V99 trailing overpunch
export const ACCT_BAL_LEN = 11;
export const ACCT_LIMIT_OFF = 53;      // S9(7)V99 COMP-3
export const ACCT_LIMIT_LEN = 5;
export const ACCT_RATE_OFF = 58;       // 9V999
export const ACCT_RATE_LEN = 4;
export const ACCT_TAX_OFF = 62;        // X(9)
export const ACCT_TAX_LEN = 9;
export const ACCT_MEMO_OFF = 71;       // X(25)
export const ACCT_MEMO_LEN = 25;
export const ACCT_FILL_OFF = 96;       // X(4) low-values
export const ACCT_FILL_LEN = 4;

// ---- TRANS, record length 80 ----
export const TRAN_RECLEN = 80;
export const TRAN_ID_OFF = 0;          // 9(10)
export const TRAN_ID_LEN = 10;
export const TRAN_ACCT_OFF = 10;       // 9(10)
export const TRAN_ACCT_LEN = 10;
export const TRAN_DATE_OFF = 20;       // 9(6) YYMMDD
export const TRAN_DATE_LEN = 6;
export const TRAN_TYPE_OFF = 26;       // X  D / C
export const TRAN_TYPE_LEN = 1;
export const TRAN_AMT_OFF = 27;        // S9(7)V99 trailing overpunch
export const TRAN_AMT_LEN = 9;
export const TRAN_STATUS_OFF = 36;     // X  O / P
export const TRAN_STATUS_LEN = 1;
export const TRAN_DESC_OFF = 37;       // X(30)
export const TRAN_DESC_LEN = 30;
export const TRAN_FILL_OFF = 67;       // X(13)
export const TRAN_FILL_LEN = 13;

export const ACCT_FILE = "ACCTMSTR";
export const TRAN_FILE = "TRANS";

export class DataFileError extends Error {}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export function dataDir(view) {
  const sub = view === "clean" ? "legacy-clean" : "legacy";
  return path.join(REPO_ROOT, "fixtures", sub);
}

export function dataFile(view, fileName) {
  return path.join(dataDir(view), fileName + ".DAT");
}

function readWhole(file) {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    throw new DataFileError("CANNOT READ " + path.basename(file) + " (" + (err && err.code ? err.code : "ERROR") + ")");
  }
}

// Effective status: X is an undocumented "closed"; unknown codes never match a LIST selection.
export function effectiveStatus(raw) {
  if (raw === "A" || raw === "S" || raw === "C") {
    return raw;
  }
  if (raw === "X") {
    return "C";
  }
  return "?";
}

// Reads ACCTMSTR. Returns { accounts, recordsRead, tailBytes, duplicates }.
// accounts keeps only the first physical record of each ACCT-ID, in physical order.
export function loadAccounts(view) {
  const buf = readWhole(dataFile(view, ACCT_FILE));
  const recordsRead = Math.floor(buf.length / ACCT_RECLEN);
  const tailBytes = buf.length % ACCT_RECLEN;
  const seen = new Set();
  const accounts = [];
  let duplicates = 0;
  for (let r = 0; r < recordsRead; r++) {
    const base = r * ACCT_RECLEN;
    const id = decodeKey(buf, base + ACCT_ID_OFF, ACCT_ID_LEN);
    if (seen.has(id)) {
      duplicates++;
      continue;
    }
    seen.add(id);
    const rawStatus = decodeText(buf, base + ACCT_STATUS_OFF, ACCT_STATUS_LEN);
    accounts.push({
      recordNo: r + 1,
      id,
      name: decodeText(buf, base + ACCT_NAME_OFF, ACCT_NAME_LEN),
      rawStatus,
      status: effectiveStatus(rawStatus),
      openDate: decodeYYMMDD(buf, base + ACCT_OPEN_OFF),
      balance: decodeZonedSigned(buf, base + ACCT_BAL_OFF, ACCT_BAL_LEN),
      creditLimit: decodePacked(buf, base + ACCT_LIMIT_OFF, ACCT_LIMIT_LEN),
      rate: decodeZonedUnsigned(buf, base + ACCT_RATE_OFF, ACCT_RATE_LEN),
      taxId: decodeText(buf, base + ACCT_TAX_OFF, ACCT_TAX_LEN),
      taxIdRaw: decodeKey(buf, base + ACCT_TAX_OFF, ACCT_TAX_LEN),
      memo: decodeText(buf, base + ACCT_MEMO_OFF, ACCT_MEMO_LEN),
    });
  }
  return { file: ACCT_FILE, accounts, recordsRead, tailBytes, duplicates };
}

// Reads TRANS. First TRAN-ID wins, same rule as the master file.
export function loadTransactions(view) {
  const buf = readWhole(dataFile(view, TRAN_FILE));
  const recordsRead = Math.floor(buf.length / TRAN_RECLEN);
  const tailBytes = buf.length % TRAN_RECLEN;
  const seen = new Set();
  const trans = [];
  let duplicates = 0;
  for (let r = 0; r < recordsRead; r++) {
    const base = r * TRAN_RECLEN;
    const id = decodeKey(buf, base + TRAN_ID_OFF, TRAN_ID_LEN);
    if (seen.has(id)) {
      duplicates++;
      continue;
    }
    seen.add(id);
    trans.push({
      recordNo: r + 1,
      id,
      acctId: decodeKey(buf, base + TRAN_ACCT_OFF, TRAN_ACCT_LEN),
      date: decodeYYMMDD(buf, base + TRAN_DATE_OFF),
      type: decodeText(buf, base + TRAN_TYPE_OFF, TRAN_TYPE_LEN),
      amount: decodeZonedSigned(buf, base + TRAN_AMT_OFF, TRAN_AMT_LEN),
      status: decodeText(buf, base + TRAN_STATUS_OFF, TRAN_STATUS_LEN),
      desc: decodeText(buf, base + TRAN_DESC_OFF, TRAN_DESC_LEN),
    });
  }
  return { file: TRAN_FILE, trans, recordsRead, tailBytes, duplicates };
}
