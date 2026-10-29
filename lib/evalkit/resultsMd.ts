// Render measured artifacts from direct results/*.json only. Each live run/split remains separate; mocks never supply metrics.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { wilson } from "./wilson.ts";

export type ResultArtifact = { file: string; value: unknown };
const Count = z.number().int().nonnegative().safe();
const Metric = z.number().finite().nonnegative().nullable();
const Outcome = z.object({
  question_id: z.string(), category: z.string(), constrained: z.boolean(), passed: z.boolean(), reason: z.string().nullable(),
  answer: z.unknown(), attempts: Count, forbidden_tool_attempts: Count, latency_ms: Metric,
  usage: z.object({ inputTokens: Count, outputTokens: Count, unknownAttempts: Count, unknownInputBound: Count, unknownOutputBound: Count }).passthrough().nullable(),
}).passthrough();
const Condition = z.object({
  condition: z.enum(["A", "C2", "C", "D"]), claim: z.string(), label: z.string(), denominator: Count, passed: Count,
  accuracy: Metric, interval: z.object({ low: z.number().finite(), high: z.number().finite() }).nullable(),
  input_tokens: Metric, output_tokens: Metric, latency_ms: Metric, cost_usd: Metric, unknown_cost_usd: Metric,
  failures: z.array(z.object({ question_id: z.string(), reason: z.string() })),
  safety: z.object({ refusal_passed: Count, refusal_total: Count, injection_pairs_passed: Count, injection_pairs_total: Count, forbidden_tool_attempts: Count }),
  outcomes: z.array(Outcome),
}).passthrough();
const Run = z.object({
  schema_version: z.literal(1), run_id: z.string(), mode: z.enum(["mock", "live"]), source: z.string(), label: z.string(),
  scope: z.enum(["benchmark", "demo"]), split: z.enum(["dev", "heldout"]), question_ids: z.array(z.string()), model: z.string().nullable(),
  started_at: z.string(), live_metrics: z.enum(["not run (live)", "measured"]), resource_policy_status: z.string(), conditions: z.array(Condition),
}).passthrough();
const Eval = z.object({ schema_version: z.literal(1), mode: z.enum(["mock", "live"]), source: z.string(), label: z.string(), runs: z.array(Run) }).passthrough();
const ParityCase = z.object({ id: z.string(), projection: z.string().nullable(), pass: z.boolean(), outcome: z.enum(["pass", "diff", "bridge_error", "infra_error"]) }).passthrough();
const Parity = z.object({ pass: z.boolean(), passed: Count, failed: Count, toleranceProblems: z.array(z.string()), results: z.array(ParityCase), set: z.string().optional(), notes: z.array(z.string()).optional() }).passthrough();
const Cell = z.object({ outcome: z.enum(["killed", "survived", "invalid", "not_executed"]), case_ids: z.array(z.string()), reason: z.string() });
const Mutation = z.object({
  version: z.literal(1), pass: z.boolean(), notes: z.array(z.string()), case_ids: z.array(z.string()), case_count: Count,
  seeded_status: z.enum(["available", "pending_generation", "provided_cases"]), selected_suites: z.array(z.enum(["full", "smoke", "schema-only"])),
  mutants: z.array(z.object({ name: z.string(), trap_case_ids: z.array(z.string()), suites: z.object({ full: Cell, smoke: Cell, "schema-only": Cell }) })),
  baseline: z.record(Parity),
  counts: z.record(z.object({ killed: Count, survived: Count, invalid: Count, not_executed: Count })),
}).passthrough();
type RunData = z.output<typeof Run>;
type ConditionData = z.output<typeof Condition>;
type ParityData = z.output<typeof Parity>;

const IDS = ["A", "C2", "C", "D"] as const;
const CLAIMS = {
  A: "Typed bridge answer correctness; compare A with C2 on feasible questions.",
  C2: "Raw bytes with copybooks: bridge-value baseline; constrained rows cannot establish superiority.",
  C: "Raw bytes without copybooks: documentation context only.",
  D: "Regex/template router: model-value baseline; abstention is a failure.",
};
const text = (value: unknown): string => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
const percent = (value: number): string => `${(value * 100).toFixed(2)}%`;
const metric = (value: number | null): string => value === null ? "pending" : String(value);
const usd = (value: number | null): string => value === null ? "pending" : `$${value.toFixed(6)}`;
function interval(passed: number, total: number): string {
  const bounds = wilson(passed, total);
  return bounds === null ? "pending" : `${percent(passed / total)} [${percent(bounds.low)}, ${percent(bounds.high)}]`;
}

function validateRun(run: RunData, mode: "mock" | "live"): void {
  if (run.mode !== mode || (mode === "mock" ? run.live_metrics !== "not run (live)" : run.live_metrics !== "measured")) throw new Error("run mode/measurement label mismatch");
  if (new Set(run.question_ids).size !== run.question_ids.length || new Set(run.conditions.map((c) => c.condition)).size !== run.conditions.length) throw new Error("duplicate question or condition identities");
  if (mode === "live" && !run.model) throw new Error("live run has no pinned model identity");
  for (const row of run.conditions) {
    const ids = row.outcomes.map((o) => o.question_id);
    if (row.denominator !== run.question_ids.length || new Set(ids).size !== ids.length || JSON.stringify([...ids].sort()) !== JSON.stringify([...run.question_ids].sort())) throw new Error(`${row.condition}: incomplete or incompatible outcome scope`);
    if (row.passed !== row.outcomes.filter((o) => o.passed).length) throw new Error(`${row.condition}: passed count disagrees with outcomes`);
    const failures = row.outcomes.filter((o) => !o.passed).map((o) => `${o.question_id}:${o.reason ?? "unknown_failure"}`).sort();
    if (JSON.stringify(failures) !== JSON.stringify(row.failures.map((f) => `${f.question_id}:${f.reason}`).sort())) throw new Error(`${row.condition}: named failure list disagrees with outcomes`);
    if (row.safety.refusal_total !== row.outcomes.filter((o) => o.category === "refusal").length ||
      row.safety.refusal_passed !== row.outcomes.filter((o) => o.category === "refusal" && o.passed).length ||
      row.safety.injection_pairs_total !== row.outcomes.filter((o) => o.category === "injection").length ||
      row.safety.injection_pairs_passed > row.safety.injection_pairs_total ||
      row.safety.forbidden_tool_attempts !== row.outcomes.reduce((n, o) => n + o.forbidden_tool_attempts, 0)) throw new Error(`${row.condition}: safety counts disagree with outcomes`);
    if (mode === "live" && row.denominator > 0 && row.accuracy !== null && Math.abs(row.accuracy - row.passed / row.denominator) > 1e-12) throw new Error(`${row.condition}: accuracy disagrees with fixed denominator`);
  }
}

function validateParity(report: ParityData, schemaOnly = false): void {
  if (new Set(report.results.map((r) => r.id)).size !== report.results.length || report.passed !== report.results.filter((r) => r.pass).length || report.failed !== report.results.length - report.passed || report.results.some((r) => r.pass !== (r.outcome === "pass"))) throw new Error("parity counts/outcomes disagree");
  // runCases accepts an empty run; runSchemaOnly requires at least one case.
  const accepted = (!schemaOnly || report.results.length > 0) && report.failed === 0 && report.toleranceProblems.length === 0;
  if (report.pass !== accepted) throw new Error("parity runner acceptance disagrees with outcomes or tolerance problems");
}

function attempted(row: ConditionData): boolean {
  return row.outcomes.some((o) => o.attempts > 0 || o.answer !== null || /exhausted|provider_error|ledger_error/.test(o.reason ?? "") || (row.condition === "D" && o.latency_ms !== null));
}

function liveRun(run: RunData, file: string): string[] {
  const lines = [`### Live run ${text(run.run_id)} (${text(file)})`, "",
    `Scope: ${text(run.scope)} / ${text(run.split)}; model: ${text(run.model ?? "missing")}; started: ${text(run.started_at)}.`,
    `Source: ${text(run.source)}. Resource policy: ${text(run.resource_policy_status)}. Questions: ${run.question_ids.map(text).join(", ") || "none"}.`,
    "This table uses only this run and split. Missing conditions stay pending; rows are never assembled across runs. Scope is the reported question set, not an inferred full split.", "",
    "| Condition and claim | Status | Fixed denominator | Accuracy and Wilson interval | Recorded input / output tokens | Known cost / unknown reserved cost | Recorded latency (ms) |", "|---|---|---|---|---|---|---|"];
  if (run.scope !== "benchmark") lines.push("| Scope notice | partial demonstration; no full benchmark comparison | pending | pending | pending | pending | pending |");
  for (const id of IDS) {
    const row = run.conditions.find((c) => c.condition === id);
    if (row === undefined || row.denominator === 0 || !attempted(row)) {
      lines.push(`| ${id}: ${text(CLAIMS[id])} | pending / not run | ${row?.denominator ?? "pending"} | pending | pending | pending | pending |`);
      continue;
    }
    const constrained = row.outcomes.filter((o) => o.constrained).length;
    const status = constrained > 0 ? `constrained (${constrained}); aggregate is not a fair comparison` : "recorded";
    const accuracy = constrained > 0 ? "pending fair aggregate; see feasible subset below" : interval(row.passed, row.denominator);
    lines.push(`| ${id}: ${text(row.claim)} | ${status} | ${row.denominator} (errors/exhaustion retained) | ${accuracy} | ${metric(row.input_tokens)} / ${metric(row.output_tokens)} | ${usd(row.cost_usd)} / ${usd(row.unknown_cost_usd)} | ${metric(row.latency_ms)} |`);
  }
  lines.push("", "Recorded token/cost/latency totals describe the whole reported condition, including failed attempts; unknown reserved cost is not billed cost. D uses no model. Constrained rows cannot establish general bridge superiority.", "",
    "| Condition | Refusal passed / total | Injection pairs passed / total | Forbidden tool attempts |", "|---|---|---|---|");
  for (const row of run.conditions) lines.push(`| ${row.condition} (${text(run.split)}) | ${row.safety.refusal_passed} / ${row.safety.refusal_total} | ${row.safety.injection_pairs_passed} / ${row.safety.injection_pairs_total} | ${row.safety.forbidden_tool_attempts} |`);
  const a = run.conditions.find((c) => c.condition === "A"), c2 = run.conditions.find((c) => c.condition === "C2");
  if (a !== undefined && c2 !== undefined && attempted(a) && attempted(c2)) {
    const feasible = c2.outcomes.filter((o) => !o.constrained).map((o) => o.question_id);
    lines.push("", "A vs C2 feasible subset within this same run/split (structural aggregation advantage remains declared):", "",
      "| Condition | Feasible question denominator | Accuracy and Wilson interval |", "|---|---|---|");
    for (const row of [a, c2]) {
      const outcomes = row.outcomes.filter((o) => feasible.includes(o.question_id));
      lines.push(`| ${row.condition} | ${outcomes.length} | ${interval(outcomes.filter((o) => o.passed).length, outcomes.length)} |`);
    }
    lines.push(`Feasible question ids: ${feasible.map(text).join(", ") || "none — comparison pending"}.`);
  }
  for (const row of run.conditions) {
    const unknown = row.outcomes.reduce((n, o) => n + (o.usage?.unknownAttempts ?? 0), 0);
    const unavailable = row.outcomes.filter((o) => o.latency_ms === null).length;
    lines.push("", `${row.condition} failures (${text(run.split)}): ${row.failures.length === 0 ? "none recorded" : row.failures.map((f) => `${text(f.question_id)} — ${text(f.reason)}`).join("; ")}.`,
      `${row.condition} unknown provider attempts: ${unknown}; question rows without latency: ${unavailable}.`);
  }
  lines.push("");
  return lines;
}

/** Pure renderer for tests/consumers; input values must be parsed direct results JSON artifacts. */
export function renderResults(artifacts: readonly ResultArtifact[]): string {
  const lines = ["# Results", "", "Evidence is limited to the artifacts named below. No absent measurement is represented as zero; mock replay is not a model result.", ""];
  let paritySeen = false; let mutationSeen = false; let liveSeen = false; let mockSeen = false;
  for (const artifact of artifacts) {
    const raw = artifact.value;
    if (typeof raw !== "object" || raw === null) { lines.push(`Invalid artifact ${text(artifact.file)}: not an object; no metrics included.`, ""); continue; }
    const value = raw as Record<string, unknown>;
    try {
      if ("runs" in value || value.mode === "live" || value.mode === "mock") {
        const parsed = Eval.parse(raw);
        const seen = new Set<string>();
        for (const run of parsed.runs) {
          if (seen.has(run.run_id)) throw new Error("duplicate run id in artifact");
          seen.add(run.run_id); validateRun(run, parsed.mode);
        }
        if (parsed.runs.length === 0) lines.push(`${text(artifact.file)}: pending; no ${parsed.mode} runs recorded.`, "");
        for (const run of parsed.runs) {
          if (run.mode === "live") { liveSeen = true; lines.push(...liveRun(run, artifact.file)); }
          else {
            mockSeen = true;
            lines.push(`### Scripted fixture ${text(run.run_id)} (${text(artifact.file)})`, "",
              `${text(run.label)}. Scope: ${text(run.scope)} / ${text(run.split)}; questions: ${run.question_ids.map(text).join(", ")}.`,
              "Accuracy, tokens, cost and latency: **not run (live)**. No mock value is copied into a live metric row.", "");
            for (const row of run.conditions) lines.push(`${row.condition}: scripted checks ${row.passed}/${row.denominator}; named failures: ${row.failures.map((f) => `${text(f.question_id)} — ${text(f.reason)}`).join("; ") || "none recorded"}.`);
            lines.push("");
          }
        }
      } else if ("mutants" in value || "seeded_status" in value) {
        const parsed = Mutation.parse(raw);
        if (parsed.case_count !== parsed.case_ids.length || new Set(parsed.case_ids).size !== parsed.case_count || new Set(parsed.mutants.map((m) => m.name)).size !== parsed.mutants.length) throw new Error("mutation case count or names disagree");
        if (parsed.selected_suites.length === 0 || new Set(parsed.selected_suites).size !== parsed.selected_suites.length) throw new Error("mutation selected suites must be nonempty and unique");
        const baselinePasses = new Map<string, boolean>();
        for (const suite of ["full", "smoke", "schema-only"] as const) {
          const base = parsed.baseline[suite];
          if (base !== undefined) validateParity(base, suite === "schema-only");
          const ids = base?.results.map((r) => r.id) ?? [];
          // classifyMutation(base, base, ids) requires a complete nonempty baseline and no infrastructure defect.
          // Full/schema use every case; the smoke producer selects exactly five smoke-tagged cases.
          const complete = suite === "smoke" ? ids.length === 5 && ids.every((id) => parsed.case_ids.includes(id)) && base?.results.every((r) => Array.isArray(r.tags) && r.tags.includes("smoke")) === true : JSON.stringify([...ids].sort()) === JSON.stringify([...parsed.case_ids].sort());
          const baselinePass = base !== undefined && base.pass && ids.length > 0 && complete && base.results.every((r) => r.pass && r.outcome === "pass" && r.infra === null);
          baselinePasses.set(suite, baselinePass);
          const counts = parsed.counts[suite];
          if (counts === undefined) throw new Error("mutation suite counts are missing");
          for (const outcome of ["killed", "survived", "invalid", "not_executed"] as const) {
            if (counts[outcome] !== parsed.mutants.filter((m) => m.suites[suite].outcome === outcome).length) throw new Error("mutation suite counts disagree");
          }
          if (parsed.mutants.some((m) => ["killed", "survived"].includes(m.suites[suite].outcome)) && !baselinePass) throw new Error("mutation detections lack a complete passing baseline");
        }
        const accepted = parsed.selected_suites.every((suite) => baselinePasses.get(suite) === true && parsed.mutants.every((m) => suite === "full" ? m.suites[suite].outcome === "killed" : ["killed", "survived"].includes(m.suites[suite].outcome)));
        if (parsed.pass !== accepted) throw new Error("mutation runner acceptance disagrees with selected-suite outcomes or baselines");
        mutationSeen = true;
        lines.push(`### Mutation detection (${text(artifact.file)})`, "", "Claim: detection of these author-chosen isolated bugs by semantic full/smoke parity versus schema/protocol checks; this says nothing about unknown bugs.",
          `Case scope: ${parsed.case_count}; ids: ${parsed.case_ids.map(text).join(", ")}. Seeded status: ${text(parsed.seeded_status)}. Runner acceptance: ${parsed.pass ? "pass" : "FAIL"}.`,
          ...parsed.notes.map((note) => `Note: ${text(note)}`), "", "| Mutant | Full | Smoke | Schema-only |", "|---|---|---|---|");
        for (const m of parsed.mutants) lines.push(`| ${text(m.name)} | ${["full", "smoke", "schema-only"].map((suite) => {
          const cell = m.suites[suite as "full" | "smoke" | "schema-only"];
          return `${cell.outcome}; cases ${cell.case_ids.map(text).join(", ") || "none"}; ${text(cell.reason)}`;
        }).join(" | ")} |`);
        lines.push("", `Selected suites: ${parsed.selected_suites.map(text).join(", ")}. No not_executed or invalid cell is a kill.`, "");
      } else if ("results" in value || "toleranceProblems" in value) {
        const parsed = Parity.parse(raw);
        validateParity(parsed);
        paritySeen = true;
        lines.push(`### Parity projections (${text(artifact.file)})`, "", "Claim: only the named bridge-to-printed-report projections under declared tolerances; shared misreadings can still pass.",
          `Scope: ${text(parsed.set ?? "reported cases only")}; ${parsed.passed}/${parsed.results.length} cases passed; runner acceptance: ${parsed.pass ? "pass" : "FAIL"}.`,
          `Projections: ${[...new Set(parsed.results.map((r) => r.projection ?? "bridge-only contract"))].map(text).join(", ")}.`,
          `Case ids: ${parsed.results.map((r) => text(r.id)).join(", ")}.`,
          `Failures: ${parsed.results.filter((r) => !r.pass).map((r) => `${text(r.id)} (${r.outcome})`).join(", ") || "none recorded"}.`,
          `Tolerance problems: ${parsed.toleranceProblems.map(text).join("; ") || "none recorded"}.`, ...(parsed.notes ?? []).map((note) => `Note: ${text(note)}`), "");
      } else lines.push(`${text(artifact.file)}: receipt or unrecognized artifact; no metrics included.`, "");
    } catch (error) {
      lines.push(`Malformed or partial artifact ${text(artifact.file)}: ${error instanceof z.ZodError ? "required report fields are missing or invalid" : text(error instanceof Error ? error.message : String(error))}; no metrics included.`, "");
    }
  }
  if (!paritySeen) lines.push("Parity projection correctness: **pending — not run**.", "");
  if (!mutationSeen) lines.push("Full / smoke / schema-only author-chosen mutation detection: **pending — not run**.", "");
  if (!liveSeen) {
    lines.push("Live answer evaluation: **not run (live)**.", "", "| Condition | Claim | Accuracy / Wilson / tokens / cost / latency |", "|---|---|---|");
    for (const id of IDS) lines.push(`| ${id} | ${text(CLAIMS[id])} | pending |`);
    lines.push("");
  }
  if (!mockSeen) lines.push("Scripted fixture replay: pending; no model metrics exist.", "");
  return lines.join("\n").trimEnd() + "\n";
}

export function generateResults(options: { repoRoot?: string; output?: string } = {}): { output: string; markdown: string } {
  const root = options.repoRoot ?? fileURLToPath(new URL("../../", import.meta.url));
  const resultsDir = join(root, "results");
  const artifacts: ResultArtifact[] = [];
  const invalid: string[] = [];
  if (existsSync(resultsDir)) for (const name of readdirSync(resultsDir).filter((n) => n.endsWith(".json")).sort()) {
    const path = join(resultsDir, name);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) { invalid.push(`Unsafe/non-file artifact ${text(name)}: no metrics read.`); continue; }
    try { artifacts.push({ file: name, value: JSON.parse(readFileSync(path, "utf8")) }); }
    catch { invalid.push(`Malformed JSON artifact ${text(name)}: no metrics read.`); }
  }
  const markdown = renderResults(artifacts) + (invalid.length === 0 ? "" : "\n" + invalid.join("\n\n") + "\n");
  const output = options.output === undefined ? join(resultsDir, "results.md") : resolve(options.output);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, markdown, "utf8");
  return { output, markdown };
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out" || !args[1])) throw new Error("usage: resultsMd.ts [--out <path>]");
    const result = generateResults(args[1] === undefined ? {} : { output: args[1] });
    process.stdout.write(`results: wrote ${result.output}; only direct results/*.json supplied metrics\n`);
  } catch (error) { process.stderr.write(`results: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
