// Mutation mapping/classification controls. No direct mutant-module import; the runner owns that boundary.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Bridge } from "../../src/bridge/createBridge.ts";
import { loadCaseFile, type ParityCase } from "../../parity/caseSchema.ts";
import { CASE_FILES, type CaseResult, type Outcome, type RunReport } from "../../parity/harness.ts";
import { classifyMutation, loadMutantDefinitions, runMutants, runSchemaOnly, validateMutantDefinitions } from "../../parity/mutate.ts";
import { TOOL_NAMES } from "../../parity/projections.ts";
import { specifiers } from "../helpers/importScan.ts";

const CASES = loadCaseFile(CASE_FILES.trap);
const EXPECTED = {
  pivot_off_by_one: "decodeDate", round_not_truncate: "monthlyInterest", overpunch_sign_misread: "decodeZoned",
  calendar_day_aging: "agingDays", last_duplicate_wins: "pickWinners", trailing_spaces_kept: "decodeText",
  lowvalues_leak: "decodeText", taxid_unmasked: "maskTaxIds", truncated_record_not_skipped: "splitRecords",
  status_x_treated_open: "effectiveStatus", no_truncation_marker: "truncationMarker", cursor_off_by_one: "nextCursorRecord",
};

function report(cases: readonly ParityCase[] = CASES, outcome: Outcome = "pass"): RunReport {
  const results: CaseResult[] = cases.map((c) => ({
    id: c.id, kind: c.kind, tool: c.tool, projection: c.projection, view: c.view, tags: c.tags, outcome,
    pass: outcome === "pass", diffs: [], matched: [], ignored: [], divergences: [], tolerancesUsed: [], pages: 1,
    bridgeError: outcome === "bridge_error" ? { code: "internal", message: "internal error" } : null,
    infra: outcome === "infra_error" ? { stage: "oracle", message: "oracle unavailable" } : null,
  }));
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, failed: cases.length - passed, toleranceProblems: [], pass: passed === cases.length };
}

const ids = CASES.map((c) => c.id);

describe("mutant catalogue", () => {
  it("contains exactly twelve isolated operation overrides, each covered by a literal trap", async () => {
    const defs = await loadMutantDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(() => validateMutantDefinitions(defs)).not.toThrow();
    for (const def of defs) {
      expect(Object.keys(def.ops)).toEqual([EXPECTED[def.name as keyof typeof EXPECTED]]);
      expect(CASES.some((c) => c.tags.includes(`mutant:${def.name}`) && c.expect !== null), def.name).toBe(true);
    }
    expect(() => validateMutantDefinitions(defs.slice(1))).toThrow(/exactly the twelve/);
    expect(() => validateMutantDefinitions(defs.map((d, i) => i === 0 ? {
      ...d, ops: { ...d.ops, nextCursorRecord: (n: number) => n },
    } : d))).toThrow(/exactly one operation/);
  });

  it("only parity/mutate.ts imports the mutant module (static/dynamic/type imports included)", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const importers: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (/\.[cm]?[jt]s$/.test(entry.name)) {
          if (specifiers(readFileSync(path, "utf8")).some((s) => /(^|\/)mutants\.[cm]?[jt]s$/.test(s))) {
            importers.push(relative(root, path).replace(/\\/g, "/"));
          }
        }
      }
    };
    for (const folder of ["src", "parity", "scripts", "tests"]) visit(join(root, folder));
    expect(importers.sort()).toEqual(["parity/mutate.ts"]);
  });
});

describe("mutation outcome controls", () => {
  it("requires a complete passing baseline and treats every structured bridge error as behaviour", () => {
    expect(classifyMutation(null, report(CASES, "diff"), ids).outcome).toBe("not_executed");
    expect(classifyMutation(report(CASES, "infra_error"), report(CASES, "diff"), ids).outcome).toBe("not_executed");
    expect(classifyMutation(report(CASES.slice(1)), report(CASES, "diff"), ids).outcome).toBe("not_executed");
    expect(classifyMutation(report(), report(), ids).outcome).toBe("survived");
    expect(classifyMutation(report(), report(CASES, "diff"), ids).outcome).toBe("killed");
    for (const code of ["bad_argument", "not_found", "invalid_cursor", "over_cap", "path_rejected", "unknown_tool", "internal"]) {
      const mutated = report(CASES, "bridge_error");
      for (const r of mutated.results) r.bridgeError = { code, message: "typed error" };
      // Unused tax-id tolerances are a consequence of a structured error, not an infrastructure outage.
      mutated.toleranceProblems = ["tax-id divergence not reached after bridge error"];
      expect(classifyMutation(report(), mutated, ids).outcome, code).toBe("killed");
    }
  });

  it("oracle/parser/import failures and incomplete or duplicate results never count as kills", () => {
    expect(classifyMutation(report(), null, ids).outcome).toBe("invalid");
    const mixed = report(CASES, "diff");
    const first = mixed.results[0];
    if (first === undefined) throw new Error("missing test case");
    first.outcome = "infra_error";
    first.infra = { stage: "parse", message: "malformed report" };
    expect(classifyMutation(report(), mixed, ids).outcome).toBe("invalid");
    expect(classifyMutation(report(), report(CASES.slice(1), "diff"), ids).outcome).toBe("invalid");
    const duplicate = report();
    duplicate.results.push({ ...first });
    expect(classifyMutation(report(), duplicate, ids).outcome).toBe("invalid");
    const stale = report();
    stale.pass = false;
    stale.toleranceProblems = ["stale declaration"];
    expect(classifyMutation(report(), stale, ids).outcome).toBe("invalid");
  });

  it("the runner stops mutant execution after a failed baseline and catches catalogue import failure", async () => {
    let calls = 0;
    const failed = await runMutants({ cases: CASES, suites: ["full"], parityRunner: async (cases) => {
      calls++;
      return report(cases, "infra_error");
    } });
    expect(calls).toBe(1);
    expect(failed.pass).toBe(false);
    expect(failed.counts.full.not_executed).toBe(12);
    const unavailable = await runMutants({ cases: CASES, suites: ["full"], parityRunner: async (cases) => report(cases),
      mutantLoader: async () => { throw new Error("import crash"); },
    });
    expect(unavailable.counts.full.invalid).toBe(12);
    expect(unavailable.counts.full.killed).toBe(0);
    expect(unavailable.pass).toBe(false);
  });

  it("the runner records actual case scope and named kills with one override set per invocation", async () => {
    const seen: Array<number> = [];
    const result = await runMutants({ cases: CASES, suites: ["full"], bridgeFactory: (opts) => {
      seen.push(Object.keys(opts.ops ?? {}).length);
      return { tools: [], fixtureDigest: opts.ops === undefined ? "baseline" : "mutated", call: async () => ({ ok: false, error: { code: "internal", message: "unused" } }) };
    }, parityRunner: async (cases, opts) => {
      const bridge = await opts.bridgeFactory({ view: "attacked" });
      return report(cases, bridge.fixtureDigest === "baseline" ? "pass" : "bridge_error");
    } });
    expect(seen).toEqual([0, ...Array.from({ length: 12 }, () => 1)]);
    expect(result.case_count).toBe(CASES.length);
    expect(result.case_ids).toEqual(ids);
    expect(result.seeded_status).toBe("provided_cases");
    expect(result.counts.full.killed).toBe(12);
    expect(result.mutants[0]?.suites.full.case_ids).toEqual(ids);
    expect(result.pass).toBe(true);
  });

  it("schema-only checks schemas/protocol without oracle or literal semantics, accepting typed errors", async () => {
    const first = CASES[0];
    if (first === undefined) throw new Error("missing test case");
    const factory = (mode: "valid" | "schema_bad" | "typed_error"): Bridge => ({
      fixtureDigest: "schema", tools: TOOL_NAMES.map((name) => ({
        name, title: name, description: name, inputSchema: z.object({}), outputSchema: z.object({ value: z.number() }).strict(),
      })),
      call: async () => mode === "typed_error" ? { ok: false, error: { code: "internal", message: "typed error" } } : {
        ok: true, structured: { value: mode === "schema_bad" ? "wrong type" : 999 },
        text: JSON.stringify({ value: mode === "schema_bad" ? "wrong type" : 999 }),
      },
    });
    expect((await runSchemaOnly([first], () => factory("valid"))).pass).toBe(true);
    expect((await runSchemaOnly([first], () => factory("typed_error"))).pass).toBe(true);
    expect((await runSchemaOnly([first], () => factory("schema_bad"))).pass).toBe(false);
  });
});
