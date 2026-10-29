// LEGACY01 command-line parsing. Strict: every argument is validated, anything unexpected is a usage error.

import { daysInMonth } from "./decode.mjs";

export class UsageError extends Error {}

export const USAGE = [
  "usage: node legacy/legacy.mjs [--view attacked|clean] <command>",
  "  INQUIRY <acct10>",
  "  LIST STATUS <A|S|C> [PREFIX <text 1-25 chars>]",
  "  HISTORY <acct10> <yyyy-mm-dd> <yyyy-mm-dd>",
  "  AGING <yyyy-mm-dd>",
  "  LAYOUT",
  "  POST <acct10> <D|C> <amount 0.01-9999999.99>   (writes to a temp copy only)",
].join("\n");

const ACCT_RE = /^[0-9]{10}$/;
const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const AMOUNT_RE = /^([0-9]{1,7})\.([0-9]{2})$/;
const PREFIX_RE = /^[\x20-\x7e]{1,25}$/;

function acct(value) {
  if (value === undefined || !ACCT_RE.test(value)) {
    throw new UsageError("ACCOUNT ID MUST BE EXACTLY 10 DIGITS");
  }
  return value;
}

function isoDate(value) {
  const m = value === undefined ? null : DATE_RE.exec(value);
  if (m === null) {
    throw new UsageError("DATE MUST BE yyyy-mm-dd");
  }
  const y = Number.parseInt(m[1], 10);
  const mo = Number.parseInt(m[2], 10);
  const d = Number.parseInt(m[3], 10);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
    throw new UsageError("NOT A CALENDAR DATE: " + value);
  }
  return { kind: "date", y, m: mo, d, key: y * 10000 + mo * 100 + d };
}

function amountMinor(value) {
  const m = value === undefined ? null : AMOUNT_RE.exec(value);
  if (m === null) {
    throw new UsageError("AMOUNT MUST BE 1-7 DIGITS, A POINT AND 2 DIGITS");
  }
  const minor = BigInt(m[1]) * 100n + BigInt(m[2]);
  if (minor === 0n) {
    throw new UsageError("AMOUNT MUST NOT BE ZERO");
  }
  return minor;
}

function expectCount(args, n) {
  if (args.length !== n) {
    throw new UsageError("WRONG NUMBER OF ARGUMENTS");
  }
}

// Returns { view, command, ...command fields }.
export function parseArgs(argv) {
  let rest = argv.slice();
  let view = "attacked";
  if (rest[0] === "--view") {
    if (rest[1] !== "attacked" && rest[1] !== "clean") {
      throw new UsageError("--view MUST BE attacked OR clean");
    }
    view = rest[1];
    rest = rest.slice(2);
  }
  const command = rest[0];
  const args = rest.slice(1);
  switch (command) {
    case "INQUIRY":
      expectCount(args, 1);
      return { view, command, acctId: acct(args[0]) };
    case "LIST": {
      if (args.length !== 2 && args.length !== 4) {
        throw new UsageError("WRONG NUMBER OF ARGUMENTS");
      }
      if (args[0] !== "STATUS") {
        throw new UsageError("LIST NEEDS STATUS <A|S|C>");
      }
      const status = args[1];
      if (status !== "A" && status !== "S" && status !== "C") {
        throw new UsageError("STATUS MUST BE A, S OR C");
      }
      let prefix = null;
      if (args.length === 4) {
        if (args[2] !== "PREFIX") {
          throw new UsageError("EXPECTED PREFIX <text>");
        }
        if (!PREFIX_RE.test(args[3])) {
          throw new UsageError("PREFIX MUST BE 1-25 PRINTABLE CHARACTERS");
        }
        prefix = args[3];
      }
      return { view, command, status, prefix };
    }
    case "HISTORY": {
      expectCount(args, 3);
      const acctId = acct(args[0]);
      const from = isoDate(args[1]);
      const to = isoDate(args[2]);
      if (from.key > to.key) {
        throw new UsageError("FROM DATE IS AFTER TO DATE");
      }
      return { view, command, acctId, from, to };
    }
    case "AGING":
      expectCount(args, 1);
      return { view, command, asOf: isoDate(args[0]) };
    case "LAYOUT":
      expectCount(args, 0);
      return { view, command };
    case "POST": {
      expectCount(args, 3);
      const acctId = acct(args[0]);
      if (args[1] !== "D" && args[1] !== "C") {
        throw new UsageError("POST TYPE MUST BE D OR C");
      }
      return { view, command, acctId, type: args[1], amount: amountMinor(args[2]) };
    }
    default:
      throw new UsageError("UNKNOWN COMMAND " + (command === undefined ? "(none)" : JSON.stringify(command)));
  }
}

const RUN_TS_RE = /^[\x20-\x7e]{1,19}$/;

// LEGACY_RUN_TS pins the only volatile field for deterministic output.
export function runTimestamp(env) {
  const pinned = env.LEGACY_RUN_TS;
  if (pinned !== undefined) {
    if (!RUN_TS_RE.test(pinned)) {
      throw new UsageError("LEGACY_RUN_TS MUST BE 1-19 PRINTABLE CHARACTERS");
    }
    return pinned;
  }
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
