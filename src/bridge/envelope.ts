// src/bridge/envelope.ts — the shared output boundary. Rows are built from decoded records (money range-checked into safe
// integers, free text wrapped as untrusted), the envelope {data, warnings, truncated, next_cursor, ...aggregates} is masked
// (ops.maskTaxIds) and only then serialised and measured against the cap; the text content is the JSON of the masked
// structured content, so both halves of the result carry the same masked data.
import { toSafeMinor } from "../fixedwidth/money.ts";
import { ToolError } from "../mcpkit/errors.ts";
import type { BridgeOps } from "./ops.ts";
import type { AccountRowOut, TransactionRowOut } from "./schemas.ts";
import type { AccountRec, TransRec } from "./store.ts";

export type Untrusted = { text: string; untrusted_text: true };

export type Structured = Record<string, unknown>;

/** The complete tool result as it is measured, audited and sent (CallToolResult without isError). */
export type ToolPayload = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Structured;
};

export function untrusted(text: string): Untrusted {
  return { text, untrusted_text: true };
}

export function accountRow(a: AccountRec, ops: BridgeOps): AccountRowOut {
  return {
    source: `ACCTMSTR#${a.record}`,
    account_id: a.account_id,
    name: untrusted(a.name),
    status: a.status,
    open_date: a.open_date,
    balance_minor: toSafeMinor(a.balance_minor),
    credit_limit_minor: toSafeMinor(a.credit_limit_minor),
    rate_thousandths: toSafeMinor(a.rate_thousandths),
    // Raw here; masked by ops.maskTaxIds in completeResult before anything is measured or exposed.
    tax_id: a.tax_id,
    memo: untrusted(a.memo),
    monthly_interest_minor: toSafeMinor(ops.monthlyInterest(a.balance_minor, a.rate_thousandths)),
  };
}

export function transactionRow(t: TransRec): TransactionRowOut {
  return {
    source: `TRANS#${t.record}`,
    tran_id: t.tran_id,
    account_id: t.account_id,
    date: t.date,
    type: t.type,
    amount_minor: toSafeMinor(t.amount_minor),
    status: t.status,
    desc: untrusted(t.desc),
  };
}

/** Mask, then wrap as the complete result. */
export function completeResult(structured: Structured, ops: BridgeOps): ToolPayload {
  const masked = ops.maskTaxIds(structured);
  return { content: [{ type: "text", text: JSON.stringify(masked) }], structuredContent: masked };
}

export function fitOptions(ops: BridgeOps, capBytes: number): { cap: number; mask: (v: object) => object } {
  return { cap: capBytes, mask: (v: object): object => ops.maskTaxIds(v) };
}

/** A result without pageable rows (account_get, describe_layouts): it fits whole or fails with over_cap. */
export function singleResult(structured: Structured, ops: BridgeOps, capBytes: number): ToolPayload {
  const fit = ops.fitRows<never>(() => completeResult(structured, ops), [], fitOptions(ops, capBytes));
  return fit.payload as ToolPayload;
}

export type PageSpec<Rec, Row> = {
  /** The whole match in physical order (index = zero-based physical record index). */
  matches: ReadonlyArray<{ index: number; rec: Rec }>;
  /** Zero-based physical index this page starts from (0 for the first page). */
  start: number;
  limit: number;
  toRow: (rec: Rec) => Row;
  /** Aggregates over the whole match, repeated on every page. */
  aggregates: Record<string, number>;
  /** Encodes a cursor for a physical record index. */
  cursorFor: (nextRecord: number) => string;
  ops: BridgeOps;
  capBytes: number;
};

/**
 * One page of rows: at most `limit` matches from `start`, then as many whole rows as fit the cap. When rows remain, the
 * envelope carries truncated: true and a cursor at the first omitted row (strictly after `start`, so paging always progresses).
 */
export function pageResult<Rec, Row>(spec: PageSpec<Rec, Row>): ToolPayload {
  const { ops } = spec;
  const remaining = spec.matches.filter((m) => m.index >= spec.start);
  const page = remaining.slice(0, spec.limit);
  const rows = page.map((m) => spec.toRow(m.rec));

  const build = (kept: Row[]): object => {
    const next = remaining[kept.length];
    const nextCursor = next === undefined ? null : spec.cursorFor(ops.nextCursorRecord(next.index));
    const capCut = kept.length < page.length;
    const marker = ops.truncationMarker({ more: next !== undefined, capCut, nextCursor });
    const warnings: string[] = [];
    if (capCut) {
      warnings.push(
        `size cap: ${kept.length} of ${page.length} rows fit in ${spec.capBytes} bytes; call again with next_cursor for the rest`,
      );
    }
    return completeResult(
      { data: kept, warnings, truncated: marker.truncated, next_cursor: marker.next_cursor, ...spec.aggregates },
      ops,
    );
  };

  const fit = ops.fitRows(build, rows, fitOptions(ops, spec.capBytes));
  if (rows.length > 0 && fit.kept === 0) throw new ToolError("over_cap", "not even one row fits under the size cap");
  return fit.payload as ToolPayload;
}
