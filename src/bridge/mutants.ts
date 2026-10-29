// Twelve isolated test-only operation overrides. Only parity/mutate.ts may import this module.
import { decodeYYMMDD } from "../fixedwidth/dates.ts";
import { defaultOps, type BridgeOps } from "./ops.ts";

export type MutantDefinition = { name: string; ops: Partial<BridgeOps> };

export const MUTANTS: readonly MutantDefinition[] = [
  { name: "pivot_off_by_one", ops: {
    decodeDate: (buf, off) => decodeYYMMDD(buf, off, 51),
  } },
  { name: "round_not_truncate", ops: {
    monthlyInterest(balance, rate) {
      const product = balance * rate;
      const magnitude = product < 0n ? -product : product;
      const rounded = (magnitude + 6000n) / 12000n;
      return product < 0n ? -rounded : rounded;
    },
  } },
  { name: "overpunch_sign_misread", ops: {
    decodeZoned(buf, off, len, signed) {
      const value = defaultOps.decodeZoned(buf, off, len, signed);
      return signed && value < 0n ? -value : value;
    },
  } },
  { name: "calendar_day_aging", ops: {
    agingDays: (from, to) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000,
  } },
  { name: "last_duplicate_wins", ops: {
    pickWinners(keys) {
      const winner = new Map<string, number>();
      let duplicateKeys = 0;
      keys.forEach((key, i) => {
        if (key === null) return;
        if (winner.has(key)) duplicateKeys++;
        winner.set(key, i);
      });
      return { winner, duplicateKeys };
    },
  } },
  { name: "trailing_spaces_kept", ops: {
    decodeText: (buf, off, len, field) => defaultOps.decodeText(buf, off, len, field).padEnd(len, " "),
  } },
  { name: "lowvalues_leak", ops: {
    decodeText: (buf, off, len, field) => defaultOps.decodeText(buf, off, len, field) +
      (field === "MEMO" ? buf.toString("latin1", off + len, off + len + 4) : ""),
  } },
  { name: "taxid_unmasked", ops: { maskTaxIds: (value) => value } },
  { name: "truncated_record_not_skipped", ops: {
    splitRecords: (length, width) => ({ records: Math.ceil(length / width), skippedTailBytes: 0 }),
  } },
  { name: "status_x_treated_open", ops: {
    effectiveStatus: (raw) => raw === "X" ? "A" : defaultOps.effectiveStatus(raw),
  } },
  { name: "no_truncation_marker", ops: {
    truncationMarker: (info) => info.capCut ? { truncated: false, next_cursor: null } : defaultOps.truncationMarker(info),
  } },
  { name: "cursor_off_by_one", ops: { nextCursorRecord: (firstOmitted) => firstOmitted + 1 } },
];
