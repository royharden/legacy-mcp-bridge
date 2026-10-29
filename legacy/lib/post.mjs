// LEGACY01 POST: the one write path of the legacy program. It never touches the fixture files: it copies
// ACCTMSTR into a fresh OS temp directory and updates the balance in that copy only. The parity harness
// refuses POST structurally; this command exists so that refusal has something real to refuse.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dataFile,
  dataDir,
  DataFileError,
  ACCT_FILE,
  ACCT_RECLEN,
  ACCT_ID_OFF,
  ACCT_ID_LEN,
  ACCT_BAL_OFF,
  ACCT_BAL_LEN,
} from "./files.mjs";
import { decodeKey, decodeZonedSigned } from "./decode.mjs";
import { editMoney } from "./edit.mjs";
import { buildLine } from "./print.mjs";

export class PostRefused extends Error {}

export const POST_LINES = {
  PST: [
    { name: "acct_id", start: 5, width: 10, kind: "code" },
    { name: "old_balance", start: 16, width: 15, kind: "money" },
    { name: "new_balance", start: 32, width: 15, kind: "money" },
    { name: "message", start: 48, width: 9, kind: "literal", value: "TEMP-COPY" },
  ],
};

const MAX_BALANCE = 99999999999n; // S9(9)V99 magnitude limit in minor units

// Trailing overpunch encoder for S9(n)V99 zoned fields.
function encodeZonedSigned(minor, len) {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(len, "0");
  const last = digits.charCodeAt(len - 1) - 0x30;
  let lastChar;
  if (last === 0) {
    lastChar = negative ? "}" : "{";
  } else {
    lastChar = String.fromCharCode((negative ? 0x4a : 0x41) + last - 1);
  }
  return Buffer.from(digits.slice(0, len - 1) + lastChar, "latin1");
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Returns { body, tempFile }. Throws PostRefused for an unknown account or an overflowing balance.
export function post(view, acctId, type, amountMinor) {
  const source = dataFile(view, ACCT_FILE);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy01-post-"));
  const tempFile = path.join(tempDir, ACCT_FILE + ".DAT");
  if (isInside(tempFile, dataDir("attacked")) || isInside(tempFile, dataDir("clean"))) {
    throw new PostRefused("TEMP COPY WOULD BE INSIDE THE DATA DIRECTORY");
  }
  try {
    fs.copyFileSync(source, tempFile);
  } catch (err) {
    throw new DataFileError("CANNOT COPY " + ACCT_FILE + " (" + (err && err.code ? err.code : "ERROR") + ")");
  }
  const buf = fs.readFileSync(tempFile);
  const records = Math.floor(buf.length / ACCT_RECLEN);
  let target = -1;
  for (let r = 0; r < records; r++) {
    if (decodeKey(buf, r * ACCT_RECLEN + ACCT_ID_OFF, ACCT_ID_LEN) === acctId) {
      target = r;
      break;
    }
  }
  if (target < 0) {
    throw new PostRefused("ACCOUNT NOT FOUND " + acctId);
  }
  const balOff = target * ACCT_RECLEN + ACCT_BAL_OFF;
  const oldBalance = decodeZonedSigned(buf, balOff, ACCT_BAL_LEN);
  if (oldBalance === null) {
    throw new PostRefused("BALANCE NOT NUMERIC " + acctId);
  }
  const newBalance = type === "D" ? oldBalance + amountMinor : oldBalance - amountMinor;
  if (newBalance > MAX_BALANCE || newBalance < -MAX_BALANCE) {
    throw new PostRefused("BALANCE OVERFLOW " + acctId);
  }
  const fd = fs.openSync(tempFile, "r+");
  try {
    fs.writeSync(fd, encodeZonedSigned(newBalance, ACCT_BAL_LEN), 0, ACCT_BAL_LEN, balOff);
  } finally {
    fs.closeSync(fd);
  }
  const body = [
    buildLine("PST", POST_LINES.PST, {
      acct_id: acctId,
      old_balance: editMoney(oldBalance, 15),
      new_balance: editMoney(newBalance, 15),
    }),
  ];
  return { body, tempFile };
}
