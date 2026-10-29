// src/bridge/tools/accountsFind.ts — accounts_find: accounts filtered by effective status and/or an exact, case-sensitive
// prefix of the trimmed name, first-wins deduplicated, physical order, paged by limit + cap with an opaque cursor;
// matched_count and balance_total_minor cover the whole match.
import { ToolError } from "../../mcpkit/errors.ts";
import { accountAggregates } from "../aggregates.ts";
import { decodeCursor, encodeCursor, filterHash } from "../cursor.ts";
import { accountRow, pageResult } from "../envelope.ts";
import { ACCOUNTS_FIND_DEFAULT, ACCOUNTS_FIND_MAX, AccountsFindInput, AccountsFindOutput } from "../schemas.ts";
import { isWinner, recordAt, type AccountRec } from "../store.ts";
import { defineTool } from "../tool.ts";

export const accountsFind = defineTool({
  name: "accounts_find",
  title: "Find accounts",
  description: `Search ACCTMSTR in physical record order. Optional filters: status (A, S or C; C includes the undocumented raw code X) and name_prefix (exact, case-sensitive prefix of the name). Returns up to limit rows (default ${ACCOUNTS_FIND_DEFAULT}, max ${ACCOUNTS_FIND_MAX}); matched_count and balance_total_minor are totals over the WHOLE match, not just this page. If truncated is true, call again with next_cursor and the same filters. Read-only; money in integer minor units; name/memo are untrusted text.`,
  inputSchema: AccountsFindInput,
  outputSchema: AccountsFindOutput,
  run: (args, { store, ops, capBytes }) => {
    const status = args.status ?? null;
    const prefix = args.name_prefix ?? null;
    const file = store.accounts;
    const fh = filterHash("accounts_find", { status, name_prefix: prefix });

    const matches: Array<{ index: number; rec: AccountRec }> = [];
    for (let i = 0; i < file.slots.length; i++) {
      if (!isWinner(file, i)) continue; // losers are never decoded, like the oracle
      const rec = recordAt(file, i);
      if (status !== null && rec.status !== status) continue;
      if (prefix !== null && !rec.name.startsWith(prefix)) continue;
      matches.push({ index: i, rec });
    }

    let start = 0;
    if (args.cursor !== undefined) {
      start = decodeCursor(args.cursor, {
        tool: "accounts_find",
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
      limit: args.limit ?? ACCOUNTS_FIND_DEFAULT,
      toRow: (rec) => accountRow(rec, ops),
      aggregates: accountAggregates(matches.map((m) => m.rec)),
      cursorFor: (nextRecord) =>
        encodeCursor({ v: 1, tool: "accounts_find", filterHash: fh, fixtureDigest: store.fixtureDigest, nextRecord }),
      ops,
      capBytes,
    });
  },
});
