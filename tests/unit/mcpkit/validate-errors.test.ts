// tests/unit/mcpkit/validate-errors.test.ts — zod helpers (account id, ISO date, limit), parseArgs ⇒ bad_argument with
// field, and the error payload mapping (unexpected exceptions ⇒ internal, no stack or detail leaked).
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BadSign } from "../../../src/fixedwidth/errors.ts";
import { ToolError, toErrorPayload } from "../../../src/mcpkit/errors.ts";
import { AccountId, IsoDate, limit, parseArgs } from "../../../src/mcpkit/validate.ts";

function failure(fn: () => unknown): { code: string; field: string | undefined } {
  try {
    fn();
  } catch (e) {
    if (e instanceof ToolError) return { code: e.code, field: e.field };
    return { code: `non-ToolError:${String(e)}`, field: undefined };
  }
  return { code: "no error", field: undefined };
}

describe("AccountId", () => {
  it("accepts exactly ten digits with leading zeros", () => {
    expect(AccountId.safeParse("0000000042").success).toBe(true);
  });
  it.each(["42", "00000000042", "000000004A", " 0000000042", "0000000042\n", ""])("rejects %j", (bad) => {
    expect(AccountId.safeParse(bad).success).toBe(false);
  });
  it("rejects a number", () => {
    expect(AccountId.safeParse(42).success).toBe(false);
  });
});

describe("IsoDate", () => {
  it("accepts real dates and rejects impossible ones", () => {
    expect(IsoDate.safeParse("2024-02-29").success).toBe(true);
    expect(IsoDate.safeParse("2023-02-29").success).toBe(false);
    expect(IsoDate.safeParse("2024-04-31").success).toBe(false);
    expect(IsoDate.safeParse("2024/04/30").success).toBe(false);
  });
});

describe("limit(max)", () => {
  it("accepts 1..max integers only", () => {
    const l = limit(50);
    expect(l.safeParse(1).success).toBe(true);
    expect(l.safeParse(50).success).toBe(true);
    expect(l.safeParse(0).success).toBe(false);
    expect(l.safeParse(51).success).toBe(false);
    expect(l.safeParse(1.5).success).toBe(false);
    expect(l.safeParse("10").success).toBe(false);
  });
});

describe("parseArgs", () => {
  const schema = z.object({ account_id: AccountId, from: IsoDate.optional(), limit: limit(100).optional() }).strict();

  it("returns parsed data", () => {
    expect(parseArgs(schema, { account_id: "0000000052", limit: 100 })).toEqual({ account_id: "0000000052", limit: 100 });
  });
  it("bad id ⇒ bad_argument on account_id", () => {
    expect(failure(() => parseArgs(schema, { account_id: "52" }))).toEqual({ code: "bad_argument", field: "account_id" });
  });
  it("bad date ⇒ bad_argument on from", () => {
    expect(failure(() => parseArgs(schema, { account_id: "0000000052", from: "2024-04-31" }))).toEqual({
      code: "bad_argument",
      field: "from",
    });
  });
  it("bad limit ⇒ bad_argument on limit", () => {
    expect(failure(() => parseArgs(schema, { account_id: "0000000052", limit: 101 }))).toEqual({
      code: "bad_argument",
      field: "limit",
    });
  });
  it("unknown key on a strict schema ⇒ bad_argument naming the key", () => {
    expect(failure(() => parseArgs(schema, { account_id: "0000000052", amount: 5 }))).toEqual({
      code: "bad_argument",
      field: "amount",
    });
  });
  it("non-object input ⇒ bad_argument", () => {
    expect(failure(() => parseArgs(schema, "0000000052")).code).toBe("bad_argument");
  });
});

describe("toErrorPayload", () => {
  it("passes ToolError code, message and field", () => {
    expect(toErrorPayload(new ToolError("bad_argument", "limit must be at most 50", "limit"))).toEqual({
      code: "bad_argument",
      message: "limit must be at most 50",
      field: "limit",
    });
  });
  it("omits field when absent", () => {
    expect(toErrorPayload(new ToolError("not_found", "no such account"))).toEqual({ code: "not_found", message: "no such account" });
  });
  it("maps any other exception to internal without detail", () => {
    const p = toErrorPayload(new BadSign("invalid overpunch byte 0x53 at offset 52"));
    expect(p).toEqual({ code: "internal", message: "internal error" });
    expect(toErrorPayload("boom")).toEqual({ code: "internal", message: "internal error" });
  });
});
