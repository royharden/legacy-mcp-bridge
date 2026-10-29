// src/bridge/tools/agingSummary.ts — aging_summary: complete bucket counts/amounts of open debits dated on or before as_of
// (30E/360), with contributing source pointers listed per bucket up to a cap; source_complete / omitted_sources say how many
// pointers were left out (the totals never are). If the byte cap still binds, whole pointers are dropped from the end.
import { agingTotals } from "../aggregates.ts";
import { completeResult, fitOptions, type ToolPayload } from "../envelope.ts";
import { AGING_SOURCES_PER_BUCKET, AgingSummaryInput, AgingSummaryOutput, type AgingBucketOut } from "../schemas.ts";
import { isWinner, recordAt, type TransRec } from "../store.ts";
import { defineTool } from "../tool.ts";

type SourceEntry = { bucket: number; source: string };

export const agingSummary = defineTool({
  name: "aging_summary",
  title: "Aging summary",
  description:
    "Age every open (O) debit (D) transaction dated on or before as_of (ISO date) with the 30E/360 day count, into buckets 0, 1-30, 31-60, 61-90 and >90 days: count and amount (integer minor units) per bucket, complete over all accounts, plus contributing TRANS#n source pointers (capped; source_complete false and omitted_sources say how many are not listed). Read-only.",
  inputSchema: AgingSummaryInput,
  outputSchema: AgingSummaryOutput,
  run: ({ as_of }, { store, ops, capBytes }) => {
    const file = store.transactions;
    const rows: TransRec[] = [];
    for (let i = 0; i < file.slots.length; i++) {
      if (isWinner(file, i)) rows.push(recordAt(file, i)); // losers are never decoded, like the oracle
    }
    const totals = agingTotals(rows, as_of, ops, AGING_SOURCES_PER_BUCKET);
    const entries: SourceEntry[] = totals.buckets.flatMap((b, bucket) => b.sources.map((source) => ({ bucket, source })));

    const build = (kept: SourceEntry[]): object => {
      const buckets: AgingBucketOut[] = totals.buckets.map((b, bi) => {
        const listed = kept.filter((e) => e.bucket === bi).map((e) => e.source);
        return {
          bucket: b.bucket,
          count: b.count,
          amount_minor: b.amount_minor,
          sources: listed,
          omitted_sources: b.count - listed.length,
        };
      });
      const omitted = buckets.reduce((n, b) => n + b.omitted_sources, 0);
      const warnings =
        omitted === 0
          ? []
          : [`sources capped: ${omitted} contributing source pointers are not listed; bucket counts and amounts are complete`];
      return completeResult(
        {
          data: { as_of, buckets },
          warnings,
          truncated: false,
          next_cursor: null,
          total_count: totals.total_count,
          total_amount_minor: totals.total_amount_minor,
          source_complete: omitted === 0,
          omitted_sources: omitted,
        },
        ops,
      );
    };

    return ops.fitRows(build, entries, fitOptions(ops, capBytes)).payload as ToolPayload;
  },
});
