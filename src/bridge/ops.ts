// src/bridge/ops.ts — BridgeOps: every decode step and legacy rule the bridge applies, as one overridable table.
// createBridge({ ops }) merges a Partial<BridgeOps> over defaultOps, so each spec mutant (M4, src/bridge/mutants.ts) is a
// single override set and the production path (stdio) always runs the defaults. Map of mutant -> op:
//   pivot_off_by_one -> decodeDate             round_not_truncate -> monthlyInterest
//   overpunch_sign_misread -> decodeZoned      calendar_day_aging -> agingDays
//   last_duplicate_wins -> pickWinners         trailing_spaces_kept -> decodeText
//   lowvalues_leak -> decodeText (field arg)   taxid_unmasked -> maskTaxIds
//   truncated_record_not_skipped -> splitRecords   status_x_treated_open -> effectiveStatus
//   no_truncation_marker -> truncationMarker   cursor_off_by_one -> nextCursorRecord
import { agingBucket, days30E360, decodeYYMMDD, type AgingBucket } from "../fixedwidth/dates.ts";
import { decodeText } from "../fixedwidth/decode.ts";
import { decodePacked, decodeZoned, monthlyInterestMinor } from "../fixedwidth/money.ts";
import { fitRows, type FitOptions, type FitResult } from "../mcpkit/cap.ts";
import { maskDeep } from "../mcpkit/mask.ts";

export type EffectiveStatus = "A" | "S" | "C";

export type Winners = {
  /** key -> zero-based physical record index of the record that represents the key. */
  winner: Map<string, number>;
  /** Number of records skipped because their key was already represented. */
  duplicateKeys: number;
};

export type RecordSplit = {
  /** Records to decode (complete records under the correct rule). */
  records: number;
  /** Bytes after the last decoded record that are skipped and counted. */
  skippedTailBytes: number;
};

export type TruncationInfo = {
  /** More matching rows exist after this page (limit or cap). */
  more: boolean;
  /** The size cap removed rows that the limit would otherwise have returned. */
  capCut: boolean;
  /** Cursor for the first omitted row, or null when nothing is omitted. */
  nextCursor: string | null;
};

export type BridgeOps = {
  /** Zoned decimal with trailing overpunch (BALANCE, AMOUNT, RATE). */
  decodeZoned(buf: Buffer, off: number, len: number, signed: boolean): bigint;
  /** COMP-3 packed decimal (CREDIT-LIMIT). */
  decodePacked(buf: Buffer, off: number, len: number): bigint;
  /** YYMMDD with century pivot; `000000` => null. */
  decodeDate(buf: Buffer, off: number): string | null;
  /** Alphanumeric field text; `field` is the copybook field name (e.g. "MEMO"). */
  decodeText(buf: Buffer, off: number, len: number, field: string): string;
  /** Raw ACCT-STATUS byte => effective code; null marks a record defect. */
  effectiveStatus(raw: string): EffectiveStatus | null;
  /** trunc(balance × rate_thousandths / 12000) toward zero. */
  monthlyInterest(balanceMinor: bigint, rateThousandths: bigint): bigint;
  /** Day count used for aging (30E/360). */
  agingDays(fromIso: string, toIso: string): number;
  agingBucket(days: number): AgingBucket;
  /** Duplicate-key rule over keys in physical order (null = undecodable key, never a winner). */
  pickWinners(keys: ReadonlyArray<string | null>): Winners;
  /** Complete-record count and skipped tail of a file. */
  splitRecords(fileLength: number, recordLength: number): RecordSplit;
  /** Tax-id masking at the output boundary (applied before cap measurement, audit hashing and exposure). */
  maskTaxIds<T>(value: T): T;
  /** Largest prefix of rows whose complete result fits the cap. */
  fitRows<T>(build: (rows: T[]) => object, rows: T[], opts?: FitOptions): FitResult;
  /** The truncation marker and cursor put into the envelope. */
  truncationMarker(info: TruncationInfo): { truncated: boolean; next_cursor: string | null };
  /** Physical record index stored in a cursor, given the index of the first omitted matching row. */
  nextCursorRecord(firstOmittedIndex: number): number;
};

const STATUS_MAP: Readonly<Record<string, EffectiveStatus>> = { A: "A", S: "S", C: "C", X: "C" };

export const defaultOps: BridgeOps = {
  decodeZoned: (buf, off, len, signed) => decodeZoned(buf, off, len, signed),
  decodePacked: (buf, off, len) => decodePacked(buf, off, len),
  decodeDate: (buf, off) => decodeYYMMDD(buf, off),
  decodeText: (buf, off, len) => decodeText(buf, off, len),
  effectiveStatus: (raw) => STATUS_MAP[raw] ?? null,
  monthlyInterest: (balanceMinor, rateThousandths) => monthlyInterestMinor(balanceMinor, rateThousandths),
  agingDays: (fromIso, toIso) => days30E360(fromIso, toIso),
  agingBucket: (days) => agingBucket(days),
  pickWinners(keys) {
    const winner = new Map<string, number>();
    let duplicateKeys = 0;
    keys.forEach((key, index) => {
      if (key === null) return;
      if (winner.has(key)) duplicateKeys += 1;
      else winner.set(key, index);
    });
    return { winner, duplicateKeys };
  },
  splitRecords: (fileLength, recordLength) => ({
    records: Math.floor(fileLength / recordLength),
    skippedTailBytes: fileLength % recordLength,
  }),
  maskTaxIds: (value) => maskDeep(value),
  fitRows: (build, rows, opts) => fitRows(build, rows, opts),
  truncationMarker: (info) => ({ truncated: info.more, next_cursor: info.more ? info.nextCursor : null }),
  nextCursorRecord: (firstOmittedIndex) => firstOmittedIndex,
};

export function mergeOps(overrides: Partial<BridgeOps> | undefined): BridgeOps {
  return { ...defaultOps, ...(overrides ?? {}) };
}
