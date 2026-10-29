// Contract: strict zod inputs. Bad ids, dates, limits, cursors and unknown fields are rejected with bad_argument naming the
// field; the unknown tool account_post is refused with unknown_tool; every tool exposes a strict input and an output schema.
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../../src/bridge/createBridge.ts";
import { expectErr, testBridge } from "../helpers/bridgeDataset.ts";

const bridge = testBridge();

describe("bridge inputs", () => {
  it("exposes exactly the five tools, each with input and output schemas", () => {
    expect(bridge.tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of bridge.tools) {
      expect(t.inputSchema._def.unknownKeys, `${t.name} input must be strict`).toBe("strict");
      expect(typeof t.outputSchema.safeParse).toBe("function");
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it.each<[string, unknown]>([
    ["too short", "123"],
    ["letters", "00000000AB"],
    ["too long", "00000000401"],
    ["number instead of string", 40],
  ])("account_get rejects a bad account_id (%s)", async (_label, account_id) => {
    const r = expectErr(await bridge.call("account_get", { account_id }));
    expect(r.error.code).toBe("bad_argument");
    expect(r.error.field).toBe("account_id");
  });

  it("rejects a missing required argument", async () => {
    const r = expectErr(await bridge.call("account_get", {}));
    expect(r.error.code).toBe("bad_argument");
    expect(r.error.field).toBe("account_id");
  });

  it.each([
    ["not a calendar date", "2023-02-29"],
    ["31 April", "2024-04-31"],
    ["wrong shape", "20240301"],
    ["month 13", "2024-13-01"],
  ])("aging_summary rejects a bad as_of (%s)", async (_label, as_of) => {
    const r = expectErr(await bridge.call("aging_summary", { as_of }));
    expect(r.error.code).toBe("bad_argument");
    expect(r.error.field).toBe("as_of");
  });

  it("transactions_list rejects bad from/to dates and from > to", async () => {
    const bad = expectErr(await bridge.call("transactions_list", { account_id: "0000000040", to: "2024-02-30" }));
    expect(bad.error).toMatchObject({ code: "bad_argument", field: "to" });
    const order = expectErr(
      await bridge.call("transactions_list", { account_id: "0000000040", from: "2024-03-02", to: "2024-03-01" }),
    );
    expect(order.error).toMatchObject({ code: "bad_argument", field: "from" });
  });

  it.each<unknown>([0, -1, 1.5, 51, "10"])("accounts_find rejects limit %s", async (limit) => {
    const r = expectErr(await bridge.call("accounts_find", { limit }));
    expect(r.error).toMatchObject({ code: "bad_argument", field: "limit" });
  });

  it.each([0, 101, 2.5])("transactions_list rejects limit %s", async (limit) => {
    const r = expectErr(await bridge.call("transactions_list", { account_id: "0000000040", limit }));
    expect(r.error).toMatchObject({ code: "bad_argument", field: "limit" });
  });

  it("rejects a status outside A/S/C (raw X is never a filter value) and an empty name_prefix", async () => {
    expect(expectErr(await bridge.call("accounts_find", { status: "X" })).error).toMatchObject({
      code: "bad_argument",
      field: "status",
    });
    expect(expectErr(await bridge.call("accounts_find", { name_prefix: "" })).error).toMatchObject({
      code: "bad_argument",
      field: "name_prefix",
    });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["account_get", { account_id: "0000000040", extra: 1 }, "extra"],
    ["describe_layouts", { verbose: true }, "verbose"],
    ["accounts_find", { status: "A", path: "../TRANS.DAT" }, "path"],
    ["transactions_list", { account_id: "0000000040", sql: "1=1" }, "sql"],
    ["aging_summary", { as_of: "2024-03-01", include_paid: true }, "include_paid"],
  ])("%s rejects unknown fields", async (tool, args, field) => {
    const r = expectErr(await bridge.call(tool, args));
    expect(r.error).toMatchObject({ code: "bad_argument", field });
  });

  it("rejects a cursor that is not a token", async () => {
    const r = expectErr(await bridge.call("accounts_find", { cursor: "not a token!" }));
    expect(r.error).toMatchObject({ code: "bad_argument", field: "cursor" });
  });

  it("refuses the unknown tool account_post (there is no write tool)", async () => {
    const r = expectErr(await bridge.call("account_post", { account_id: "0000000040", amount: 100 }));
    expect(r.error.code).toBe("unknown_tool");
  });

  it("rejects non-object arguments", async () => {
    for (const args of [null, "0000000040", 42, ["0000000040"]]) {
      expect(expectErr(await bridge.call("account_get", args)).error.code).toBe("bad_argument");
    }
  });
});
