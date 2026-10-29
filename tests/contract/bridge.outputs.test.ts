// Contract: every successful result validates against its output schema, every record carries a one-based source, free
// text is wrapped as untrusted, tax ids leave masked, low-values never leak, aggregates cover the whole match, the duplicate
// key and truncated tail follow the legacy rules, and history of an account absent from ACCTMSTR is empty (not not_found).
// Expected literals are worked out by hand in tests/helpers/bridgeDataset.ts.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_KEYS } from "../../src/mcpkit/audit.ts";
import { expectErr, expectOk, rowsOf, TAIL_KEY, testBridge, type OkResult } from "../helpers/bridgeDataset.ts";

const bridge = testBridge();

function validates(tool: string, r: OkResult): void {
  const def = bridge.tools.find((t) => t.name === tool);
  if (def === undefined) throw new Error(`no tool ${tool}`);
  const parsed = def.outputSchema.safeParse(r.structured);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  // The text content is the JSON of the same masked structured content.
  expect(JSON.parse(r.text)).toEqual(r.structured);
  expect(r.text).not.toContain("\\u0000");
}

describe("bridge outputs", () => {
  it("account_get decodes overpunch, packed limit, interest truncation and masks the tax id", async () => {
    const r = expectOk(await bridge.call("account_get", { account_id: "0000000040" }));
    validates("account_get", r);
    expect(r.structured["data"]).toEqual({
      source: "ACCTMSTR#1",
      account_id: "0000000040",
      name: { text: "HARTLEY MERCANTILE LTD", untrusted_text: true },
      status: "A",
      open_date: "1998-03-15",
      balance_minor: -123456,
      credit_limit_minor: 250000,
      rate_thousandths: 35,
      tax_id: "***-**-1234",
      memo: { text: "OVERDRAWN - REVIEW", untrusted_text: true },
      monthly_interest_minor: -360,
    });
    expect(r.text).not.toContain("900421234");
    expect(r.structured).toMatchObject({ warnings: [], truncated: false, next_cursor: null });
  });

  it("first duplicate wins: ACCTMSTR#5 (same key) is invisible", async () => {
    const r = expectOk(await bridge.call("account_get", { account_id: "0000000040" }));
    expect(r.text).not.toContain("DUPLICATE SECOND COPY");
  });

  it("interest truncates toward zero (46913, not the rounded 46914)", async () => {
    const r = expectOk(await bridge.call("account_get", { account_id: "0000000043" }));
    validates("account_get", r);
    expect(r.structured["data"]).toMatchObject({
      source: "ACCTMSTR#4",
      balance_minor: 9876543,
      rate_thousandths: 57,
      monthly_interest_minor: 46913,
      open_date: "2005-01-01",
    });
  });

  it("keeps internal double spaces, maps raw X to C and 000000 to null", async () => {
    const smith = expectOk(await bridge.call("account_get", { account_id: "0000000041" }));
    expect(smith.structured["data"]).toMatchObject({ name: { text: "SMITH  JONES  AND PARTNER", untrusted_text: true } });
    const x = expectOk(await bridge.call("account_get", { account_id: "0000000042" }));
    expect(x.structured["data"]).toMatchObject({ status: "C" });
    expect(x.text).not.toContain('"status":"X"');
    const never = expectOk(await bridge.call("account_get", { account_id: "0000000044" }));
    expect(never.structured["data"]).toMatchObject({ open_date: null, status: "C", source: "ACCTMSTR#6" });
  });

  it("the truncated tail's key is not found", async () => {
    const r = expectErr(await bridge.call("account_get", { account_id: TAIL_KEY }));
    expect(r.error).toMatchObject({ code: "not_found", field: "account_id" });
  });

  it("accounts_find: whole-match aggregates, physical order, sources, untrusted text", async () => {
    const all = expectOk(await bridge.call("accounts_find", {}));
    validates("accounts_find", all);
    expect(rowsOf(all).map((x) => x.source)).toEqual(["ACCTMSTR#1", "ACCTMSTR#2", "ACCTMSTR#3", "ACCTMSTR#4", "ACCTMSTR#6"]);
    expect(all.structured).toMatchObject({ matched_count: 5, balance_total_minor: 9788087, truncated: false, next_cursor: null });
    for (const row of rowsOf(all)) {
      expect(row["name"]).toMatchObject({ untrusted_text: true });
      expect(row["memo"]).toMatchObject({ untrusted_text: true });
      expect(String(row["tax_id"])).toMatch(/^\*\*\*-\*\*-\d{4}$/);
    }

    const closed = expectOk(await bridge.call("accounts_find", { status: "C" }));
    expect(rowsOf(closed).map((x) => x.source)).toEqual(["ACCTMSTR#3", "ACCTMSTR#6"]);
    expect(closed.structured).toMatchObject({ matched_count: 2, balance_total_minor: 25000 });

    const har = expectOk(await bridge.call("accounts_find", { name_prefix: "HAR" }));
    expect(rowsOf(har).map((x) => x.source)).toEqual(["ACCTMSTR#1", "ACCTMSTR#6"]);
    expect(har.structured).toMatchObject({ matched_count: 2, balance_total_minor: -118456 });

    const caseSensitive = expectOk(await bridge.call("accounts_find", { name_prefix: "har" }));
    expect(caseSensitive.structured).toMatchObject({ matched_count: 0, balance_total_minor: 0, data: [] });
  });

  it("transactions_list: range filter, whole-match debit/credit totals, sources", async () => {
    const r = expectOk(await bridge.call("transactions_list", { account_id: "0000000040" }));
    validates("transactions_list", r);
    expect(rowsOf(r).map((x) => x.source)).toEqual(["TRANS#1", "TRANS#2", "TRANS#4", "TRANS#5"]);
    expect(r.structured).toMatchObject({ matched_count: 4, debit_total_minor: 103000, credit_total_minor: 50000 });
    expect(rowsOf(r)[0]).toEqual({
      source: "TRANS#1",
      tran_id: "0000000001",
      account_id: "0000000040",
      date: "2024-01-31",
      type: "D",
      amount_minor: 100000,
      status: "O",
      desc: { text: "INVOICE 1", untrusted_text: true },
    });

    const ranged = expectOk(
      await bridge.call("transactions_list", { account_id: "0000000040", from: "2024-02-15", to: "2024-03-01" }),
    );
    expect(rowsOf(ranged).map((x) => x.source)).toEqual(["TRANS#2", "TRANS#4"]);
    expect(ranged.structured).toMatchObject({ matched_count: 2, debit_total_minor: 1000, credit_total_minor: 50000 });
  });

  it("transactions_list for an account absent from ACCTMSTR is zero rows, zero totals (not not_found)", async () => {
    const r = expectOk(await bridge.call("transactions_list", { account_id: "0000000739" }));
    validates("transactions_list", r);
    expect(r.structured).toMatchObject({
      data: [],
      matched_count: 0,
      debit_total_minor: 0,
      credit_total_minor: 0,
      truncated: false,
      next_cursor: null,
    });
  });

  it("aging_summary: 30E/360 buckets over open debits on or before as_of, with sources", async () => {
    const r = expectOk(await bridge.call("aging_summary", { as_of: "2024-03-01" }));
    validates("aging_summary", r);
    expect(r.structured["data"]).toEqual({
      as_of: "2024-03-01",
      buckets: [
        { bucket: "0", count: 1, amount_minor: 1000, sources: ["TRANS#4"], omitted_sources: 0 },
        { bucket: "1-30", count: 0, amount_minor: 0, sources: [], omitted_sources: 0 },
        { bucket: "31-60", count: 1, amount_minor: 100000, sources: ["TRANS#1"], omitted_sources: 0 },
        { bucket: "61-90", count: 0, amount_minor: 0, sources: [], omitted_sources: 0 },
        { bucket: ">90", count: 1, amount_minor: 2500, sources: ["TRANS#3"], omitted_sources: 0 },
      ],
    });
    expect(r.structured).toMatchObject({ total_count: 3, total_amount_minor: 103500, source_complete: true, omitted_sources: 0 });
  });

  it("describe_layouts: fields, copybook pointers, mask rule and diagnostics", async () => {
    const r = expectOk(await bridge.call("describe_layouts", {}));
    validates("describe_layouts", r);
    const data = r.structured["data"] as {
      layouts: Array<{ record: string; copybook: string; record_length: number; fields: Array<Record<string, unknown>>; diagnostics: unknown }>;
      rules: Record<string, string>;
    };
    const [acct, trans] = data.layouts;
    expect(acct).toMatchObject({ record: "ACCTMSTR", copybook: "ACCTMSTR.cpy", record_length: 100 });
    expect(trans).toMatchObject({ record: "TRANS", copybook: "TRANS.cpy", record_length: 80 });
    expect(acct?.diagnostics).toEqual({ records_read: 6, skipped_tail_bytes: 37, duplicate_keys: 1 });
    expect(trans?.diagnostics).toEqual({ records_read: 5, skipped_tail_bytes: 0, duplicate_keys: 0 });
    expect(acct?.fields.find((f) => f["name"] === "TAX-ID")).toMatchObject({ mask: "last4", offset: 62, length: 9 });
    expect(acct?.fields.find((f) => f["name"] === "OPEN-DATE")).toMatchObject({ date_window: { pivot: 50, never: "000000" } });
    for (const f of [...(acct?.fields ?? []), ...(trans?.fields ?? [])]) {
      expect(String(f["meaning"]).length).toBeGreaterThan(0);
      expect(String(f["quirk"]).length).toBeGreaterThan(0);
      expect(f["copybook"]).toMatchObject({ file: expect.stringMatching(/\.cpy$/) });
    }
    expect(data.rules["tax_id_mask"]).toContain("***-**-");
  });

  it("audit lines hold only hashes and sizes (allowed keys), never bodies or ids", async () => {
    const auditPath = join(mkdtempSync(join(tmpdir(), "lmb-audit-")), "audit.jsonl");
    const audited = testBridge({ auditPath });
    expectOk(await audited.call("account_get", { account_id: "0000000040" }));
    expectErr(await audited.call("account_post", {}));
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(Object.keys(JSON.parse(line) as object).sort()).toEqual([...AUDIT_KEYS].sort());
      expect(line).not.toContain("0000000040");
      expect(line).not.toContain("HARTLEY");
    }
  });
});
