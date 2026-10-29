// Contract: paging. Limit and cap truncation set truncated: true with a next_cursor that resumes at the first omitted row
// (strictly forward, never a zero-row page); aggregates are identical on every page; the cap drops whole rows; a tampered,
// foreign (other tool / other filter), malformed or stale cursor is invalid_cursor.
import { describe, expect, it } from "vitest";
import type { Bridge } from "../../src/bridge/createBridge.ts";
import {
  ACCOUNTS,
  acctFileBytes,
  expectErr,
  expectOk,
  resultBytes,
  rowsOf,
  testBridge,
  writeDataset,
  type OkResult,
} from "../helpers/bridgeDataset.ts";

const bridge = testBridge();

const recordNo = (source: string): number => Number(source.slice(source.indexOf("#") + 1));

async function pageAll(b: Bridge, tool: string, args: Record<string, unknown>): Promise<OkResult[]> {
  const pages: OkResult[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 50; guard++) {
    const call: Record<string, unknown> = cursor === null ? args : { ...args, cursor };
    const page = expectOk(await b.call(tool, call));
    pages.push(page);
    const next = page.structured["next_cursor"];
    if (next === null) return pages;
    expect(typeof next).toBe("string");
    cursor = next as string;
  }
  throw new Error("paging did not terminate");
}

function sources(pages: OkResult[]): string[] {
  return pages.flatMap((p) => rowsOf(p).map((r) => r.source));
}

function reencode(cursor: string, patch: (o: Record<string, unknown>) => unknown): string {
  const o = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
  return Buffer.from(JSON.stringify(patch(o)), "utf8").toString("base64url");
}

async function firstCursor(): Promise<string> {
  const page = expectOk(await bridge.call("accounts_find", { limit: 2 }));
  const c = page.structured["next_cursor"];
  if (typeof c !== "string") throw new Error("expected a cursor");
  return c;
}

describe("bridge paging", () => {
  it("accounts_find pages by limit: truncation marker, cursor, union = whole match, aggregates on every page", async () => {
    const pages = await pageAll(bridge, "accounts_find", { limit: 2 });
    expect(pages).toHaveLength(3);
    expect(sources(pages)).toEqual(["ACCTMSTR#1", "ACCTMSTR#2", "ACCTMSTR#3", "ACCTMSTR#4", "ACCTMSTR#6"]);
    pages.forEach((p, i) => {
      const last = i === pages.length - 1;
      expect(p.structured["truncated"]).toBe(!last);
      expect(p.structured["next_cursor"] === null).toBe(last);
      expect(rowsOf(p).length).toBeGreaterThan(0);
      expect(p.structured).toMatchObject({ matched_count: 5, balance_total_minor: 9788087 });
    });
    // Strictly forward progress.
    const firsts = pages.map((p) => recordNo(rowsOf(p)[0]?.source ?? "#0"));
    for (let i = 1; i < firsts.length; i++) expect(firsts[i]).toBeGreaterThan(firsts[i - 1] ?? 0);
  });

  it("transactions_list pages by limit with whole-match totals on every page", async () => {
    const pages = await pageAll(bridge, "transactions_list", { account_id: "0000000040", limit: 1 });
    expect(sources(pages)).toEqual(["TRANS#1", "TRANS#2", "TRANS#4", "TRANS#5"]);
    for (const p of pages) {
      expect(p.structured).toMatchObject({ matched_count: 4, debit_total_minor: 103000, credit_total_minor: 50000 });
    }
  });

  it("the size cap drops whole rows, marks truncation, warns and resumes at the first omitted row", async () => {
    const oneRow = expectOk(await bridge.call("accounts_find", { limit: 1 }));
    const capBytes = resultBytes(oneRow) + 400;
    const capped = testBridge({ capBytes });

    const first = expectOk(await capped.call("accounts_find", { limit: 5 }));
    const kept = rowsOf(first).length;
    expect(kept).toBeGreaterThanOrEqual(1);
    expect(kept).toBeLessThan(5);
    expect(first.structured["truncated"]).toBe(true);
    expect(typeof first.structured["next_cursor"]).toBe("string");
    expect((first.structured["warnings"] as string[]).some((w) => w.startsWith("size cap:"))).toBe(true);
    expect(resultBytes(first)).toBeLessThanOrEqual(capBytes);

    const pages = await pageAll(capped, "accounts_find", { limit: 5 });
    for (const p of pages) expect(resultBytes(p)).toBeLessThanOrEqual(capBytes);
    const all = ["ACCTMSTR#1", "ACCTMSTR#2", "ACCTMSTR#3", "ACCTMSTR#4", "ACCTMSTR#6"];
    expect(sources(pages)).toEqual(all);
    // The second page starts exactly at the first row the cap omitted.
    expect(rowsOf(pages[1] ?? first)[0]?.source).toBe(all[kept]);
  });

  it("a result whose mandatory content cannot fit is over_cap", async () => {
    const tiny = testBridge({ capBytes: 200 });
    expect(expectErr(await tiny.call("account_get", { account_id: "0000000040" })).error.code).toBe("over_cap");
    expect(expectErr(await tiny.call("accounts_find", {})).error.code).toBe("over_cap");
  });

  it.each<[string, (o: Record<string, unknown>) => unknown]>([
    ["nextRecord moved onto a non-matching (duplicate) record", (o) => ({ ...o, nextRecord: 4 })],
    ["nextRecord 0", (o) => ({ ...o, nextRecord: 0 })],
    ["nextRecord past the end", (o) => ({ ...o, nextRecord: 999 })],
    ["nextRecord not an integer", (o) => ({ ...o, nextRecord: 2.5 })],
    ["filterHash altered", (o) => ({ ...o, filterHash: "0".repeat(32) })],
    ["fixtureDigest altered", (o) => ({ ...o, fixtureDigest: "f".repeat(64) })],
    ["version altered", (o) => ({ ...o, v: 2 })],
    ["tool altered", (o) => ({ ...o, tool: "transactions_list" })],
    ["extra field", (o) => ({ ...o, admin: true })],
    [
      "missing field",
      (o) => {
        const copy = { ...o };
        delete copy["nextRecord"];
        return copy;
      },
    ],
    ["not an object", () => [1, 2, 3]],
  ])("a tampered cursor is invalid_cursor (%s)", async (_label, patch) => {
    const tampered = reencode(await firstCursor(), patch);
    const r = expectErr(await bridge.call("accounts_find", { limit: 2, cursor: tampered }));
    expect(r.error).toMatchObject({ code: "invalid_cursor", field: "cursor" });
  });

  it("a non-canonical or undecodable cursor is invalid_cursor", async () => {
    const c = await firstCursor();
    const spaced = Buffer.from(JSON.stringify(JSON.parse(Buffer.from(c, "base64url").toString("utf8")), null, 1)).toString(
      "base64url",
    );
    for (const token of [spaced, "abc", "AAAA"]) {
      expect(expectErr(await bridge.call("accounts_find", { limit: 2, cursor: token })).error.code).toBe("invalid_cursor");
    }
  });

  it("a cursor is bound to its tool and filter", async () => {
    const c = await firstCursor();
    const otherFilter = expectErr(await bridge.call("accounts_find", { status: "A", limit: 2, cursor: c }));
    expect(otherFilter.error.code).toBe("invalid_cursor");
    const otherTool = expectErr(await bridge.call("transactions_list", { account_id: "0000000040", cursor: c }));
    expect(otherTool.error.code).toBe("invalid_cursor");
    // limit is not part of the filter: resuming with another page size is allowed.
    expectOk(await bridge.call("accounts_find", { limit: 1, cursor: c }));
  });

  it("a cursor from different data bytes is stale => invalid_cursor", async () => {
    const c = await firstCursor();
    const changed = ACCOUNTS.map((a, i) => (i === 1 ? { ...a, memo: "CHANGED" } : a));
    const other = testBridge({}, writeDataset(acctFileBytes(changed)));
    expect(other.fixtureDigest).not.toBe(bridge.fixtureDigest);
    const r = expectErr(await other.call("accounts_find", { limit: 2, cursor: c }));
    expect(r.error.code).toBe("invalid_cursor");
    expect(r.error.message).toContain("stale");
    // Identical bytes in another directory give the same digest, so the cursor still resumes.
    expectOk(await testBridge().call("accounts_find", { limit: 2, cursor: c }));
  });
});
