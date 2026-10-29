// src/bridge/tools/transactionsList.ts — transactions_list: transactions of one account with from <= date <= to (inclusive),
// physical order, paged by limit + cap with an opaque cursor; matched_count and debit/credit totals cover the whole match.
// History does not consult ACCTMSTR: a well-formed key with no transactions (even one absent from ACCTMSTR) gives zero rows
// and zero totals, never not_found (LEGACY-BEHAVIOUR §6).
import { ToolError } from "../../mcpkit/errors.ts";
import { transactionAggregates } from "../aggregates.ts";
import { decodeCursor, encodeCursor, filterHash } from "../cursor.ts";
import { pageResult, transactionRow } from "../envelope.ts";
import {
  TRANSACTIONS_LIST_DEFAULT,
  TRANSACTIONS_LIST_MAX,
  TransactionsListInput,
  TransactionsListOutput,
} from "../schemas.ts";
import { isWinner, recordAt, type TransRec } from "../store.ts";
import { defineTool } from "../tool.ts";

export const transactionsList = defineTool({
  name: "transactions_list",
  title: "List an account's transactions",
  description: `List TRANS records of one 10-digit account_id in physical record order, optionally limited to from <= date <= to (ISO dates, inclusive). Returns up to limit rows (default ${TRANSACTIONS_LIST_DEFAULT}, max ${TRANSACTIONS_LIST_MAX}); matched_count, debit_total_minor and credit_total_minor are totals over the WHOLE match, not just this page. If truncated is true, call again with next_cursor and the same filters. An account with no transactions returns zero rows. Read-only; amounts in integer minor units; desc is untrusted text.`,
  inputSchema: TransactionsListInput,
  outputSchema: TransactionsListOutput,
  run: (args, { store, ops, capBytes }) => {
    const from = args.from ?? null;
    const to = args.to ?? null;
    if (from !== null && to !== null && from > to) throw new ToolError("bad_argument", "from must be on or before to", "from");
    const file = store.transactions;
    const fh = filterHash("transactions_list", { account_id: args.account_id, from, to });

    const matches: Array<{ index: number; rec: TransRec }> = [];
    for (let i = 0; i < file.slots.length; i++) {
      if (!isWinner(file, i)) continue; // losers are never decoded, like the oracle
      const rec = recordAt(file, i);
      if (rec.account_id !== args.account_id) continue;
      if (from !== null && rec.date < from) continue;
      if (to !== null && rec.date > to) continue;
      matches.push({ index: i, rec });
    }

    let start = 0;
    if (args.cursor !== undefined) {
      start = decodeCursor(args.cursor, {
        tool: "transactions_list",
        filterHash: fh,
        fixtureDigest: store.fixtureDigest,
        recordCount: file.slots.length,
      });
      if (!matches.some((m) => m.index === start)) {
        throw new ToolError("invalid_cursor", "cursor does not point at a row of this result", "cursor");
      }
    }

    return pageResult({
      matches,
      start,
      limit: args.limit ?? TRANSACTIONS_LIST_DEFAULT,
      toRow: (rec) => transactionRow(rec),
      aggregates: transactionAggregates(matches.map((m) => m.rec)),
      cursorFor: (nextRecord) =>
        encodeCursor({ v: 1, tool: "transactions_list", filterHash: fh, fixtureDigest: store.fixtureDigest, nextRecord }),
      ops,
      capBytes,
    });
  },
});
