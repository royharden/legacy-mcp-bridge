// src/bridge/aggregates.ts — totals over the WHOLE match (never just the page), in BigInt, range-checked into safe integers:
// accounts_find (matched_count, balance_total_minor), transactions_list (matched_count, debit/credit totals) and the aging
// buckets (open debits dated on or before as_of, day count and bucket from BridgeOps, sources capped per bucket).
import { AGING_BUCKETS, type AgingBucket } from "../fixedwidth/dates.ts";
import { toSafeMinor } from "../fixedwidth/money.ts";
import { ToolError } from "../mcpkit/errors.ts";
import type { BridgeOps } from "./ops.ts";
import type { AccountRec, TransRec } from "./store.ts";

export function accountAggregates(rows: readonly AccountRec[]): { matched_count: number; balance_total_minor: number } {
  let total = 0n;
  for (const r of rows) total += r.balance_minor;
  return { matched_count: rows.length, balance_total_minor: toSafeMinor(total) };
}

export function transactionAggregates(rows: readonly TransRec[]): {
  matched_count: number;
  debit_total_minor: number;
  credit_total_minor: number;
} {
  let debit = 0n;
  let credit = 0n;
  for (const r of rows) {
    if (r.type === "D") debit += r.amount_minor;
    else credit += r.amount_minor;
  }
  return { matched_count: rows.length, debit_total_minor: toSafeMinor(debit), credit_total_minor: toSafeMinor(credit) };
}

export type AgingBucketTotals = {
  bucket: AgingBucket;
  count: number;
  amount_minor: number;
  /** Source pointers of contributing rows (physical order), capped at `perBucket`. */
  sources: string[];
  /** Contributing rows beyond the cap (their pointers are not listed). */
  omitted_sources: number;
};

export type AgingTotals = {
  buckets: AgingBucketTotals[];
  total_count: number;
  total_amount_minor: number;
};

/** Open (O) debit (D) rows with date <= asOf, bucketed by ops.agingDays / ops.agingBucket. `rows` is in physical order. */
export function agingTotals(rows: readonly TransRec[], asOf: string, ops: BridgeOps, perBucket: number): AgingTotals {
  const acc = new Map<AgingBucket, { count: number; amount: bigint; sources: string[] }>();
  for (const b of AGING_BUCKETS) acc.set(b, { count: 0, amount: 0n, sources: [] });
  let totalCount = 0;
  let totalAmount = 0n;
  for (const r of rows) {
    if (r.status !== "O" || r.type !== "D" || r.date > asOf) continue;
    const bucket = ops.agingBucket(ops.agingDays(r.date, asOf));
    const entry = acc.get(bucket);
    if (entry === undefined) throw new ToolError("internal", "aging produced an unknown bucket");
    entry.count += 1;
    entry.amount += r.amount_minor;
    entry.sources.push(`TRANS#${r.record}`);
    totalCount += 1;
    totalAmount += r.amount_minor;
  }
  const buckets = AGING_BUCKETS.map((bucket): AgingBucketTotals => {
    const e = acc.get(bucket) ?? { count: 0, amount: 0n, sources: [] };
    return {
      bucket,
      count: e.count,
      amount_minor: toSafeMinor(e.amount),
      sources: e.sources.slice(0, perBucket),
      omitted_sources: Math.max(0, e.sources.length - perBucket),
    };
  });
  return { buckets, total_count: totalCount, total_amount_minor: toSafeMinor(totalAmount) };
}
