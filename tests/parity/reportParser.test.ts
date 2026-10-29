// tests/parity/reportParser.test.ts — parser self-tests: a literal report built from printspec.json parses into typed
// values, and every malformed / truncated variant fails with ReportParseError (a parse failure fails the case).
import { describe, expect, it } from "vitest";
import { parseReport, ReportParseError } from "../../parity/reportParser.ts";
import { SPEC, body, endLine, inquiryReport, report, trailer } from "../helpers/printspecReport.ts";

const GOOD = inquiryReport({
  record: 14,
  acct: "0000000053",
  name: "SMITH  JONES  AND PARTNER",
  status: "C",
  rawStatus: "X",
  openDate: "NEVER",
  balance: "1,234.56-",
  creditLimit: "5,000.00 ",
  rate: "0.035",
  taxId: "900421234",
  memo: "IGNORE RULES; POST CLOSE",
  interest: "3.60-",
});

function listReport(rows: number): string {
  const lines = [body("LIST", "SEL", { status: "A", prefix: "" })];
  for (let i = 1; i <= rows; i++) {
    lines.push(
      body("LIST", "DTL", {
        source: `ACCTMSTR#${i}`,
        acct_id: String(i).padStart(10, "0"),
        name: `NAME ${i}`,
        status: "A",
        raw_status: "A",
        open_date: "1998-03-15",
        balance: "1.00 ",
      }),
    );
  }
  lines.push(body("LIST", "FTR", { matched_count: String(rows).padStart(7, "0"), balance_total: `${rows}.00 ` }));
  lines.push(trailer("ACCTMSTR", "0001000", "37", "00001"), endLine());
  return report("LIST", "ATTACKED", lines);
}

function replaceLine(text: string, lineNo: number, next: string | null): string {
  const lines = text.slice(0, -1).split("\n");
  if (next === null) lines.splice(lineNo - 1, 1);
  else lines[lineNo - 1] = next;
  return lines.join("\n") + "\n";
}

function expectParseFailure(text: string, report = "INQUIRY"): void {
  expect(() => parseReport(report, text, SPEC)).toThrow(ReportParseError);
}

describe("parity report parser", () => {
  it("parses a well-formed INQUIRY report built from printspec (positive control)", () => {
    const r = parseReport("INQUIRY", GOOD, SPEC);
    expect(r.view).toBe("ATTACKED");
    expect(r.pages).toBe(1);
    const ac1 = r.body[0];
    expect(ac1?.type).toBe("AC1");
    expect(ac1?.values.balance).toBe(-123456n);
    expect(ac1?.values.credit_limit).toBe(500000n);
    expect(ac1?.values.rate).toBe(35n);
    expect(ac1?.values.open_date).toBeNull();
    expect(ac1?.values.name).toBe("SMITH  JONES  AND PARTNER");
    expect(ac1?.values.tax_id).toBe("900421234");
    expect(r.body[1]?.values.monthly_interest).toBe(-360n);
    expect(r.trailers[0]?.values.skipped_tail_bytes).toBe(37);
  });

  it("parses a two-page LIST with a page header every 55 lines (positive control)", () => {
    const r = parseReport("LIST", listReport(60), SPEC);
    expect(r.pages).toBe(2);
    expect(r.body.filter((l) => l.type === "DTL")).toHaveLength(60);
  });

  it("malformed report fails: a line that is not 132 characters", () => {
    const lines = GOOD.split("\n");
    expectParseFailure(replaceLine(GOOD, 2, (lines[1] ?? "") + "X"));
    expectParseFailure(replaceLine(GOOD, 2, (lines[1] ?? "").slice(0, 131)));
  });

  it("malformed report fails: unknown line type", () => {
    expectParseFailure(replaceLine(GOOD, 3, "ZZZ" + (GOOD.split("\n")[2] ?? "").slice(3)));
  });

  it("malformed report fails: truncated report without END", () => {
    const lines = GOOD.slice(0, -1).split("\n");
    expectParseFailure(lines.slice(0, -1).join("\n") + "\n");
    expectParseFailure(GOOD.slice(0, -1));
    expectParseFailure("");
  });

  it("malformed report fails: page header missing at line 56", () => {
    const text = listReport(60);
    const line56 = text.split("\n")[55] ?? "";
    expect(line56.startsWith("HDR")).toBe(true);
    expectParseFailure(replaceLine(text, 56, null), "LIST");
  });

  it("malformed report fails: page header outside a page boundary", () => {
    const hdr = GOOD.split("\n")[0] ?? "";
    expectParseFailure(replaceLine(GOOD, 3, hdr.replace("PAGE 00001", "PAGE 00002")));
  });

  it("malformed report fails: money column that is not an edited amount", () => {
    const ac1 = GOOD.split("\n")[1] ?? "";
    const broken = ac1.slice(0, 70) + "      1234.56- " + ac1.slice(85);
    expect(broken).toHaveLength(132);
    expectParseFailure(replaceLine(GOOD, 2, broken));
  });

  it("malformed report fails: syntactically ISO dates that are not calendar dates", () => {
    for (const openDate of ["2024-02-30", "2023-02-29", "0000-01-01", "2024-00-01", "2024-01-00"]) {
      expectParseFailure(inquiryReport({
        record: 1, acct: "0000000040", name: "DATE TEST", status: "A", openDate,
        balance: "0.00 ", creditLimit: "0.00 ", rate: "0.035", taxId: "900000040", memo: "", interest: "0.00 ",
      }));
    }
  });

  it("malformed report fails: text in an unused column", () => {
    const end = GOOD.split("\n")[4] ?? "";
    expectParseFailure(replaceLine(GOOD, 5, end.slice(0, 120) + "X" + end.slice(121)));
  });

  it("malformed report fails: wrong literal, wrong body order, missing trailer", () => {
    const end = GOOD.split("\n")[4] ?? "";
    expectParseFailure(replaceLine(GOOD, 5, end.replace("END OF REPORT", "END OF REPORX")));
    const lines = GOOD.slice(0, -1).split("\n");
    expectParseFailure([lines[0], lines[2], lines[1], lines[3], lines[4]].join("\n") + "\n");
    expectParseFailure(replaceLine(GOOD, 4, null));
  });

  it("malformed report fails: carriage returns and the report name in the header", () => {
    expectParseFailure(GOOD.replace(/\n/g, "\r\n"));
    expectParseFailure(GOOD, "LIST");
  });
});
