// Synthetic report fixtures test evidence rendering only. These are not product measurements and never populate results/.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateResults, renderResults, type ResultArtifact } from "../../lib/evalkit/resultsMd.ts";

function condition(id: "A" | "C2" | "C" | "D", constrained = false) {
  const outcomes = [true, false].map((passed, i) => ({
    question_id: `Q${i + 1}`, category: i === 0 ? "history" : "aging", constrained: constrained && i === 1,
    passed, reason: passed ? null : "budget_exhausted", answer: passed ? { status: "answer", value: 100 } : null,
    attempts: 1, forbidden_tool_attempts: 0, latency_ms: 5,
    usage: { inputTokens: 10, outputTokens: 2, unknownAttempts: 0, unknownInputBound: 0, unknownOutputBound: 0 },
  }));
  return {
    condition: id, claim: `fixture claim ${id}`, label: "live evaluation", denominator: 2, passed: 1,
    accuracy: 0.5, interval: { low: 0.09, high: 0.91 }, input_tokens: 20, output_tokens: 4,
    latency_ms: 10, cost_usd: 0.001, unknown_cost_usd: 0,
    failures: [{ question_id: "Q2", reason: "budget_exhausted" }],
    safety: { refusal_passed: 0, refusal_total: 0, injection_pairs_passed: 0, injection_pairs_total: 0, forbidden_tool_attempts: 0 }, outcomes,
  };
}
function run(runId: string, split: "dev" | "heldout", ids: Array<"A" | "C2" | "C" | "D"> = ["A", "C2", "C", "D"]) {
  return { schema_version: 1, run_id: runId, mode: "live", source: "synthetic test artifact", label: "live evaluation", scope: "benchmark", split,
    question_ids: ["Q1", "Q2"], model: "test-model", started_at: "2000-01-01T00:00:00.000Z", live_metrics: "measured", resource_policy_status: "test fixture",
    conditions: ids.map((id) => condition(id, id === "C2")),
  };
}
function artifact(runs: unknown[], mode = "live"): ResultArtifact {
  return { file: `eval-${mode}.json`, value: { schema_version: 1, mode, source: "synthetic test fixture", label: "test fixture", runs } };
}
function parityFixture(passed = true, toleranceProblems: string[] = [], ids = ["T01"]) {
  return { pass: passed && toleranceProblems.length === 0, passed: passed ? ids.length : 0, failed: passed ? 0 : ids.length, toleranceProblems,
    results: ids.map((id) => ({ id, projection: "account_inquiry", pass: passed, outcome: passed ? "pass" : "diff", infra: null, tags: ["smoke"] })),
  };
}
type Suite = "full" | "smoke" | "schema-only";
type MutationOutcome = "killed" | "survived" | "invalid" | "not_executed";
function mutationFixture(suite: Suite, outcome: MutationOutcome, pass: boolean) {
  const case_ids = ["T01", "T02", "T03", "T04", "T05"];
  const cell = (value: MutationOutcome) => ({ outcome: value, case_ids: value === "killed" ? ["T01"] : [], reason: "synthetic test control" });
  const suites = { full: cell("not_executed"), smoke: cell("not_executed"), "schema-only": cell("not_executed") };
  suites[suite] = cell(outcome);
  const counts = { full: { killed: 0, survived: 0, invalid: 0, not_executed: 0 }, smoke: { killed: 0, survived: 0, invalid: 0, not_executed: 0 }, "schema-only": { killed: 0, survived: 0, invalid: 0, not_executed: 0 } };
  for (const name of ["full", "smoke", "schema-only"] as const) counts[name][suites[name].outcome]++;
  return { version: 1, pass, notes: [], case_ids, case_count: case_ids.length, seeded_status: "provided_cases", selected_suites: [suite],
    baseline: { [suite]: parityFixture(true, [], case_ids) },
    mutants: [{ name: "synthetic_mutant", trap_case_ids: ["T01"], suites }], counts,
  };
}

describe("results artifact renderer", () => {
  it("renders consistent parity acceptance and legitimate case/tolerance failures", () => {
    const good = renderResults([{ file: "parity.json", value: parityFixture() }]);
    expect(good).toContain("1/1 cases passed; runner acceptance: pass");
    for (const value of [parityFixture(false), parityFixture(true, ["unused tolerance"])]) {
      const output = renderResults([{ file: "parity.json", value }]);
      expect(output).toContain("runner acceptance: FAIL");
      expect(output).not.toContain("Malformed or partial artifact");
    }
  });

  it.each([
    { ...parityFixture(false), pass: true },
    { ...parityFixture(true, ["unused tolerance"]), pass: true },
    { ...parityFixture(), pass: false },
  ])("rejects parity acceptance that contradicts case outcomes or tolerance problems", (value) => {
    // what_bug_this_catches: pass:true with zero passing cases, or with tolerance failures, used to print acceptance pass.
    const output = renderResults([{ file: "parity.json", value }]);
    expect(output).toContain("Malformed or partial artifact parity.json");
    expect(output).toContain("parity runner acceptance disagrees");
    expect(output).not.toContain("### Parity projections");
  });

  it.each([
    ["full", "killed"], ["smoke", "survived"], ["schema-only", "survived"],
  ] as const)("accepts %s/%s under the producer's selected-suite rule", (suite, outcome) => {
    const output = renderResults([{ file: "mutants.json", value: mutationFixture(suite, outcome, true) }]);
    expect(output).toContain("Runner acceptance: pass");
    expect(output).not.toContain("Malformed or partial artifact");
  });

  it("renders a legitimate full-suite survivor as runner acceptance FAIL", () => {
    const output = renderResults([{ file: "mutants.json", value: mutationFixture("full", "survived", false) }]);
    expect(output).toContain("Runner acceptance: FAIL");
    expect(output).toContain("survived");
    expect(output).not.toContain("Malformed or partial artifact");
  });

  it.each([
    mutationFixture("full", "survived", true), mutationFixture("smoke", "invalid", true),
    mutationFixture("schema-only", "not_executed", true), mutationFixture("full", "killed", false),
  ])("rejects mutation acceptance that contradicts the selected suite's cells", (value) => {
    // what_bug_this_catches: top-level pass was trusted even for full survivors or invalid/unexecuted selected cells.
    const output = renderResults([{ file: "mutants.json", value }]);
    expect(output).toContain("Malformed or partial artifact mutants.json");
    expect(output).toContain("mutation runner acceptance disagrees");
    expect(output).not.toContain("### Mutation detection");
  });

  it("validates embedded parity acceptance before trusting a mutation baseline", () => {
    const value = mutationFixture("full", "killed", true);
    value.baseline.full = { ...parityFixture(false, [], value.case_ids), pass: true };
    const output = renderResults([{ file: "mutants.json", value }]);
    expect(output).toContain("parity runner acceptance disagrees");
    expect(output).not.toContain("### Mutation detection");
  });

  it("rejects full-suite detections with an incomplete or infrastructure-defective baseline", () => {
    for (const incomplete of [true, false]) {
      const value = mutationFixture("full", "killed", true);
      value.baseline.full = parityFixture(true, [], incomplete ? ["T01"] : value.case_ids);
      if (!incomplete) {
        const row = value.baseline.full.results[0];
        if (row === undefined) throw new Error("missing baseline row");
        Object.assign(row, { infra: { stage: "oracle", message: "synthetic infrastructure defect" } });
      }
      const output = renderResults([{ file: "mutants.json", value }]);
      expect(output).toContain("mutation detections lack a complete passing baseline");
      expect(output).not.toContain("### Mutation detection");
    }
  });

  it("leaves absent and unattempted measurements pending, never invented zero accuracy", () => {
    const empty = renderResults([]);
    expect(empty).toContain("not run (live)");
    for (const id of ["A", "C2", "C", "D"]) expect(empty).toContain(`| ${id} |`);
    expect(empty).not.toContain("0.00%");
    const unattempted = run("not-started", "dev", ["A"]);
    const row = unattempted.conditions[0];
    if (row === undefined) throw new Error("missing fixture row");
    row.passed = 0; row.accuracy = 0;
    row.outcomes = row.outcomes.map((o) => ({ ...o, passed: false, reason: "truth_error", answer: null, attempts: 0 }));
    row.failures = row.outcomes.map((o) => ({ question_id: o.question_id, reason: "truth_error" }));
    const output = renderResults([artifact([unattempted])]);
    expect(output).toContain("pending / not run");
    expect(output).not.toContain("0.00%");
  });

  it("uses fixed denominators and named failures while separating constrained feasible comparisons", () => {
    const output = renderResults([artifact([run("single-run", "dev")])]);
    expect(output).toContain("single-run");
    expect(output).toContain("50.00%");
    expect(output).toContain("2 (errors/exhaustion retained)");
    expect(output).toContain("Q2 — budget_exhausted");
    expect(output).toContain("constrained (1)");
    expect(output).toContain("pending fair aggregate");
    expect(output).toContain("A vs C2 feasible subset within this same run/split");
    expect(output).toContain("Feasible question ids: Q1");
    expect(output).toContain("unknown reserved cost is not billed cost");
  });

  it("never merges different runs/splits into a complete A/C2 comparison", () => {
    const output = renderResults([artifact([run("first-dev", "dev", ["A"]), run("second-heldout", "heldout", ["C2"])])]);
    expect(output).toContain("Live run first-dev");
    expect(output).toContain("Live run second-heldout");
    expect(output).not.toContain("A vs C2 feasible subset");
    expect(output).toContain("rows are never assembled across runs");
  });

  it("mock replay cannot populate live accuracy, cost, latency or token metric rows", () => {
    const mocked = { ...run("scripted", "dev"), mode: "mock", model: null, live_metrics: "not run (live)", label: "SCRIPTED FIXTURE — not a model result" };
    const output = renderResults([artifact([mocked], "mock")]);
    expect(output).toContain("Scripted fixture scripted");
    expect(output).toContain("No mock value is copied into a live metric row");
    expect(output).not.toContain("50.00%");
    expect(output).not.toContain("$0.001000");
    expect(output).toContain("Live answer evaluation: **not run (live)**");
  });

  it("labels malformed/incompatible scope explicitly and includes no metrics from that artifact", () => {
    const incompatible = run("bad-scope", "dev");
    const row = incompatible.conditions[0];
    if (row === undefined) throw new Error("missing row");
    row.denominator = 3;
    const output = renderResults([artifact([incompatible]), { file: "partial.json", value: { mode: "live" } }]);
    expect(output).toContain("Malformed or partial artifact eval-live.json");
    expect(output).toContain("Malformed or partial artifact partial.json");
    expect(output).not.toContain("50.00%");
  });

  it("reads only direct results JSON files, leaves nested/source reports out, and writes Markdown", () => {
    const root = mkdtempSync(join(tmpdir(), "lmb-results-test-"));
    const results = join(root, "results");
    mkdirSync(join(results, "runs"), { recursive: true });
    mkdirSync(join(root, "eval"));
    writeFileSync(join(results, "eval-live.json"), JSON.stringify(artifact([run("included", "dev")]).value));
    writeFileSync(join(results, "runs", "nested.json"), "not valid JSON");
    writeFileSync(join(root, "eval", "questions.heldout.jsonl"), "MUST NOT READ THIS SOURCE");
    writeFileSync(join(results, "broken.json"), "not valid JSON");
    const result = generateResults({ repoRoot: root });
    expect(result.output).toBe(join(results, "results.md"));
    expect(readFileSync(result.output, "utf8")).toBe(result.markdown);
    expect(result.markdown).toContain("included");
    expect(result.markdown).toContain("Malformed JSON artifact broken.json");
    expect(result.markdown).not.toContain("nested.json");
    expect(result.markdown).not.toContain("MUST NOT READ THIS SOURCE");
  });
});
