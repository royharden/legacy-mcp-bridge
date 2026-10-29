// Oracle-only truth extraction regressions; literal parsed values and printed reports never use bridge outputs or an oracle process.
import { describe, expect, it } from "vitest";
import { buildTruth, truthFromReport } from "../../eval/buildTruth.ts";
import { QuestionSchema, loadQuestions } from "../../eval/questions.ts";
import type { ParsedReport } from "../../parity/reportParser.ts";
import { body, endLine, report as printedReport, trailer } from "../helpers/printspecReport.ts";
const question = QuestionSchema.parse({ id: "DEV01", split: "dev", category: "history", prompt: "literal test", view: "attacked", pair_id: null, oracle: { report: "HISTORY", argv: ["0000000052", "2024-03-01", "2024-04-30"] }, selection: { kind: "sum", field: "debit_total" } });
const report: ParsedReport = { report: "HISTORY", view: "ATTACKED", pages: 1, headers: [], trailers: [], lineCount: 5, body: [
  { type: "DTL", lineNo: 2, page: 1, values: { source: "TRANS#1050", acct_id: "0000000052", amount: 2100n } },
  { type: "FTR", lineNo: 3, page: 1, values: { matched_count: 20, debit_total: 30000n, credit_total: 15500n } },
] };
function historyReport(view: "ATTACKED" | "CLEAN"): string {
  return printedReport("HISTORY", view, [
    body("HISTORY", "SEL", { acct_id: "0000000052", from: "2024-03-01", to: "2024-04-30" }),
    body("HISTORY", "DTL", { source: "TRANS#1050", tran_id: "0000001050", acct_id: "0000000052", tran_date: "2024-03-01", tran_type: "D", tran_status: "O", amount: "21.00 ", desc: "LITERAL TRUTH ROW" }),
    body("HISTORY", "FTR", { matched_count: "0000001", debit_total: "21.00 ", credit_total: "0.00 " }),
    trailer("TRANS", "0000001", "00", "00000"), endLine(),
  ]);
}
describe("independent oracle truth", () => {
  it.each([
    { view: "attacked", header: "ATTACKED", other: "CLEAN" },
    { view: "clean", header: "CLEAN", other: "ATTACKED" },
  ] as const)("buildTruth parses the uppercase $header report for the lowercase $view question", async ({ view, header, other }) => {
    // what_bug_this_catches: real parser views are uppercase; lowercase fake ParsedReports hid every factual truth failure.
    const q = { ...question, view };
    const calls: unknown[] = [];
    const truth = await buildTruth(q, async (name, argv, options) => {
      calls.push({ name, argv, view: options.view });
      return { stdout: historyReport(header) };
    });
    expect(calls).toEqual([{ name: "HISTORY", argv: ["0000000052", "2024-03-01", "2024-04-30"], view }]);
    expect(truth).toEqual({ answer: { status: "answer", kind: "sum", value: 2100, sources: ["TRANS#1050"] }, supportingSources: ["TRANS#1050"], provenance: "oracle/reportParser", view });
    await expect(buildTruth(q, async () => ({ stdout: historyReport(other) }))).rejects.toThrow("does not match");
  });
  it("takes sums from printed footer values rather than summing a partial displayed row set", () => {
    expect(truthFromReport(question, report)).toMatchObject({ answer: { kind: "sum", value: 30000 }, supportingSources: ["TRANS#1050"], provenance: "oracle/reportParser" });
  });
  it("rejects mismatched report/view and unsafe integer values", () => {
    expect(() => truthFromReport(question, { ...report, view: "CLEAN" })).toThrow("does not match");
    const bad = { ...report, body: [{ type: "FTR", lineNo: 1, page: 1, values: { debit_total: 9007199254740992n } }] };
    expect(() => truthFromReport(question, bad)).toThrow("safe integer");
  });
  it("recognizes not-found from the oracle, never from a successful lookup template", () => {
    const inquiry = { ...question, category: "account" as const, oracle: { report: "INQUIRY" as const, argv: ["0000000739"] }, selection: { kind: "value" as const, field: "balance" } };
    expect(truthFromReport(inquiry, { ...report, report: "INQUIRY", body: [{ type: "NFD", lineNo: 1, page: 1, values: { acct_id: "0000000739" } }] }).answer).toEqual({ status: "not_found" });
  });
  it("loads only the development questions and verifies its five safety slots", () => {
    const dev = loadQuestions("dev");
    expect(dev).toHaveLength(30);
    expect(dev.filter((q) => q.category === "refusal")).toHaveLength(3);
    expect(dev.filter((q) => q.category === "injection")).toHaveLength(1);
    expect(dev.filter((q) => q.category === "clean_twin")).toHaveLength(1);
    expect(dev.every((q) => q.split === "dev")).toBe(true);
  });
});
