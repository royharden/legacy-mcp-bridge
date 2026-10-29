// tests/parity/tolerances.test.ts — tolerance self-tests: exactly two kinds; a stale (unused), unreasoned or wildcard
// declaration each fails; case ids must exist; the committed parity/tolerances.json obeys the same rules.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Bridge, ToolResult } from "../../src/bridge/createBridge.ts";
import { CaseSchema, loadCaseFile } from "../../parity/caseSchema.ts";
import { CASE_FILES, runCases } from "../../parity/harness.ts";
import {
  TOLERANCES_PATH,
  ToleranceError,
  unusedTolerances,
  validateTolerances,
} from "../../parity/tolerances.ts";
import { SPEC, body, endLine, report, trailer } from "../helpers/printspecReport.ts";

const KNOWN = new Set(["T01", "T02"]);

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "run_ts", kind: "ignore_volatile", field: "hdr.run_ts", reason: "run timestamp in the page header", cases: ["T01"], ...over };
}

function problemsOf(tolerances: unknown[]): string[] {
  try {
    validateTolerances({ version: 1, tolerances }, KNOWN);
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(ToleranceError);
    return (e as ToleranceError).problems;
  }
}

describe("parity tolerances", () => {
  it("a well-formed declaration validates (positive control)", () => {
    expect(problemsOf([entry()])).toEqual([]);
  });

  it("stale (unused) tolerance fails after a run", async () => {
    // T01 is an INQUIRY for an account the oracle does not find, so the declared tax-id divergence is never applied.
    const nfd = report("INQUIRY", "ATTACKED", [
      body("INQUIRY", "NFD", { acct_id: "0000001040" }),
      trailer("ACCTMSTR", "0001000", "37", "00001"),
      endLine(),
    ]);
    const c = CaseSchema.parse({
      id: "T01",
      kind: "parity",
      tool: "account_get",
      args: { account_id: "0000001040" },
      oracle: { report: "INQUIRY", argv: ["0000001040"] },
      projection: "account_inquiry",
      expect: { error: { code: "not_found" } },
      tags: ["trap:truncated_tail"],
      what_bug_this_catches: "a partial tail record decoded as an account",
    });
    const tolerances = validateTolerances(
      {
        version: 1,
        tolerances: [
          entry(),
          { id: "taxid_mask", kind: "expected_divergence", field: "tax_id", reason: "legacy prints the raw tax id", transform: "mask_taxid", cases: ["T01"] },
        ],
      },
      KNOWN,
    );
    const notFound: ToolResult = { ok: false, error: { code: "not_found", message: "account not found" } };
    const bridge: Bridge = { tools: [], fixtureDigest: "test", call: async () => notFound };
    const run = await runCases([c], { bridgeFactory: () => bridge, oracle: async () => ({ stdout: nfd }), tolerances, printspec: SPEC });
    expect(run.results[0]?.outcome).toBe("pass");
    expect(run.toleranceProblems).toEqual(["tolerance taxid_mask: unused for case T01 (stale declaration)"]);
    expect(run.pass).toBe(false);
    // Pairs for cases that did not run are not judged.
    expect(unusedTolerances(tolerances, new Set(["T02"]), [])).toEqual([]);
  });

  it("unreasoned tolerance fails", () => {
    expect(problemsOf([entry({ reason: undefined })]).join("\n")).toMatch(/unreasoned/);
    expect(problemsOf([entry({ reason: "   " })]).join("\n")).toMatch(/unreasoned/);
    expect(problemsOf([entry({ reason: "because" })]).join("\n")).toMatch(/unreasoned/);
  });

  it("wildcard tolerance fails", () => {
    expect(problemsOf([entry({ field: "*" })]).join("\n")).toMatch(/wildcard field/);
    expect(problemsOf([entry({ id: "rows", kind: "expected_divergence", field: "rows[*].name", transform: "mask_taxid" })]).join("\n")).toMatch(/wildcard field/);
    expect(problemsOf([entry({ cases: ["T*"] })]).join("\n")).toMatch(/wildcard case/);
  });

  it("only the two kinds exist, each in its own lane", () => {
    expect(problemsOf([entry({ kind: "ignore_difference" })]).length).toBeGreaterThan(0);
    expect(problemsOf([entry({ kind: "expected_divergence", field: "balance_minor", transform: "mask_taxid" })]).join("\n")).toMatch(/only to tax_id/);
    expect(problemsOf([entry({ field: "balance_minor" })]).join("\n")).toMatch(/volatile oracle column/);
    expect(problemsOf([entry({ kind: "expected_divergence", field: "tax_id" })]).join("\n")).toMatch(/needs a transform/);
  });

  it("listed cases must exist and be explicit", () => {
    expect(problemsOf([entry({ cases: ["T99"] })]).join("\n")).toMatch(/T99 does not exist/);
    expect(problemsOf([entry({ cases: [] })]).join("\n")).toMatch(/lists no cases/);
    expect(problemsOf([entry(), entry({ id: "run_ts_again" })]).join("\n")).toMatch(/already declared/);
  });

  it("the committed parity/tolerances.json validates against the committed case files", () => {
    const raw = JSON.parse(readFileSync(TOLERANCES_PATH, "utf8")) as { tolerances: { kind: string }[] };
    expect(new Set(raw.tolerances.map((t) => t.kind))).toEqual(new Set(["ignore_volatile", "expected_divergence"]));
    const ids = new Set<string>();
    for (const f of Object.values(CASE_FILES)) {
      if (existsSync(f)) for (const c of loadCaseFile(f)) ids.add(c.id);
    }
    expect(() => validateTolerances(raw, ids)).not.toThrow();
  });
});
