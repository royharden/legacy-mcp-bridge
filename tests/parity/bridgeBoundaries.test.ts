// Public-bridge regressions for exact masked-result caps and the M2 duplicate-winner fix (55cefa9).
// All records are literal bytes assembled here; no generated fixture, oracle or internal cap/cursor helper is used.
import { describe, expect, it } from "vitest";
import { createBridge } from "../../src/bridge/createBridge.ts";
import {
  acctRecord, expectErr, expectOk, rowsOf, transRecord, writeDataset, type OkResult,
} from "../helpers/bridgeDataset.ts";

function payloadBytes(structured: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured,
  }), "utf8");
}

function capCandidate(page: OkResult, kept: number, total: number, cap: number): Record<string, unknown> {
  return {
    ...page.structured,
    warnings: kept === total ? [] : [
      `size cap: ${kept} of ${total} rows fit in ${cap} bytes; call again with next_cursor for the rest`,
    ],
  };
}

describe("parity bridge boundaries", () => {
  it("account_get fits at the exact complete masked payload size and fails one byte below", async () => {
    // what_bug_this_catches: measuring only structuredContent, measuring before masking, or using < instead of <=.
    const root = writeDataset(acctRecord({ id: "0000000040", tax: "900421234" }), Buffer.alloc(0));
    const call = { account_id: "0000000040" };
    const result = expectOk(await createBridge({ dataRoot: root }).call("account_get", call));
    const cap = payloadBytes(result.structured);
    expect(JSON.stringify(result)).not.toContain("900421234");
    expect(JSON.stringify(result)).toContain("***-**-1234");
    const exact = expectOk(await createBridge({ dataRoot: root, capBytes: cap }).call("account_get", call));
    expect(payloadBytes(exact.structured)).toBe(cap);
    expect(exact.structured).toEqual(result.structured);
    const below = expectErr(await createBridge({ dataRoot: root, capBytes: cap - 1 }).call("account_get", call));
    expect(below.error.code).toBe("over_cap");
  });

  it("a cap-cut page is the largest whole-row prefix at an exact marker/cursor-inclusive boundary", async () => {
    // what_bug_this_catches: underfilling a cap page, omitting text/markers/cursor bytes, or resuming at the wrong row.
    const total = 40;
    const kept = 20;
    const trans = Array.from({ length: total }, (_, i) => transRecord({
      id: String(i + 1).padStart(10, "0"), acct: "0000000040", date: "240101", type: "D",
      amount: "00000010{", status: "O", desc: "CAP BOUNDARY LITERAL ROW TEXT",
    }));
    const root = writeDataset(acctRecord({ id: "0000000040" }), Buffer.concat(trans));
    const bridge = createBridge({ dataRoot: root });
    const args = { account_id: "0000000040", from: "2024-01-01", to: "2024-01-31" };
    const prefix = expectOk(await bridge.call("transactions_list", { ...args, limit: kept }));
    const plusOne = expectOk(await bridge.call("transactions_list", { ...args, limit: kept + 1 }));
    const full = expectOk(await bridge.call("transactions_list", { ...args, limit: total }));
    // Warning text includes the cap. The five-digit placeholder and actual boundary have equal width.
    const cap = payloadBytes(capCandidate(prefix, kept, total, 10000));
    expect(String(cap)).toHaveLength(5);
    expect(payloadBytes(capCandidate(prefix, kept, total, cap))).toBe(cap);
    expect(payloadBytes(capCandidate(plusOne, kept + 1, total, cap))).toBeGreaterThan(cap);
    expect(payloadBytes(full.structured)).toBeGreaterThan(cap);

    const bounded = createBridge({ dataRoot: root, capBytes: cap });
    const first = expectOk(await bounded.call("transactions_list", { ...args, limit: total }));
    expect(rowsOf(first)).toHaveLength(kept);
    expect(first.structured).toEqual(capCandidate(prefix, kept, total, cap));
    expect(payloadBytes(first.structured)).toBe(cap);
    expect(first.structured.truncated).toBe(true);
    expect(typeof first.structured.next_cursor).toBe("string");
    const next = expectOk(await bounded.call("transactions_list", {
      ...args, limit: total, cursor: first.structured.next_cursor,
    }));
    expect(rowsOf(next)[0]?.source).toBe("TRANS#21");
    const below = expectOk(await createBridge({ dataRoot: root, capBytes: cap - 1 }).call("transactions_list", {
      ...args, limit: total,
    }));
    expect(rowsOf(below).length).toBeLessThan(kept);
  });

  it("malformed duplicate losers cannot break search, history or aging; malformed winners still fail", async () => {
    // what_bug_this_catches: 55cefa9's scan-order regression: recordAt before isWinner throws on a duplicate loser.
    const goodAccount = acctRecord({ id: "0000000040", balance: "0000001000{" });
    const badAccount = acctRecord({ id: "0000000040", balance: "ABCDEFGHIJK" });
    const goodTrans = transRecord({
      id: "0000000001", acct: "0000000040", date: "240101", type: "D",
      amount: "00000010{", status: "O", desc: "WINNER",
    });
    const badTrans = transRecord({
      id: "0000000001", acct: "0000000040", date: "240230", type: "D",
      amount: "00000010{", status: "O", desc: "MALFORMED DUPLICATE",
    });
    const root = writeDataset(Buffer.concat([goodAccount, badAccount]), Buffer.concat([goodTrans, badTrans]));
    const bridge = createBridge({ dataRoot: root });
    const found = expectOk(await bridge.call("accounts_find", {}));
    expect(found.structured.matched_count).toBe(1);
    expect(found.structured.balance_total_minor).toBe(10000);
    expect(rowsOf(found).map((r) => r.source)).toEqual(["ACCTMSTR#1"]);
    const history = expectOk(await bridge.call("transactions_list", { account_id: "0000000040" }));
    expect(history.structured.matched_count).toBe(1);
    expect(history.structured.debit_total_minor).toBe(100);
    expect(rowsOf(history).map((r) => r.source)).toEqual(["TRANS#1"]);
    const aging = expectOk(await bridge.call("aging_summary", { as_of: "2024-01-01" }));
    expect(aging.structured.total_count).toBe(1);
    expect(aging.structured.total_amount_minor).toBe(100);

    const badRoot = writeDataset(Buffer.concat([badAccount, goodAccount]), Buffer.concat([badTrans, goodTrans]));
    const bad = createBridge({ dataRoot: badRoot });
    for (const [tool, args] of [
      ["accounts_find", {}], ["transactions_list", { account_id: "0000000040" }],
      ["aging_summary", { as_of: "2024-01-01" }],
    ] as const) {
      expect(expectErr(await bad.call(tool, args)).error.code).toBe("internal");
    }
  });

  it.each(["first", "last"] as const)("accounts_find fails for an unreadable ACCT-ID in the %s record", async (position) => {
    // what_bug_this_catches: a null key was treated as a duplicate loser, silently omitting its row and balance.
    const good = acctRecord({ id: "0000000040", name: "VISIBLE ACCOUNT", balance: "0000001000{" });
    const bad = acctRecord({ id: "00000000X1", name: "OTHER ACCOUNT", balance: "0000002000{" });
    const root = writeDataset(Buffer.concat(position === "first" ? [bad, good] : [good, bad]), Buffer.alloc(0));
    const bridge = createBridge({ dataRoot: root });
    expect(expectErr(await bridge.call("accounts_find", {})).error.code).toBe("internal");
    expect(expectErr(await bridge.call("accounts_find", { name_prefix: "VISIBLE" })).error.code).toBe("internal");
  });

  it.each(["first", "last"] as const)("history and aging fail for an unreadable TRAN-ID in the %s record", async (position) => {
    // what_bug_this_catches: winner-before-read discarded malformed primary keys before decoding or applying filters.
    const good = transRecord({
      id: "0000000001", acct: "0000000040", date: "240101", type: "D",
      amount: "00000010{", status: "O", desc: "VISIBLE TRANSACTION",
    });
    const bad = transRecord({
      id: "00000000X2", acct: "0000000041", date: "240102", type: "D",
      amount: "00000020{", status: "O", desc: "OTHER ACCOUNT AND FUTURE DATE",
    });
    const root = writeDataset(
      acctRecord({ id: "0000000040" }), Buffer.concat(position === "first" ? [bad, good] : [good, bad]),
    );
    const bridge = createBridge({ dataRoot: root });
    expect(expectErr(await bridge.call("transactions_list", { account_id: "0000000040" })).error.code).toBe("internal");
    expect(expectErr(await bridge.call("aging_summary", { as_of: "2024-01-01" })).error.code).toBe("internal");
  });
});
