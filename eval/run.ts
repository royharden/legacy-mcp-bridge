// Eval activation entrypoint. Explicit mock/live modes, independent oracle truth, fixed denominators, and separate artifacts.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { openLedger, type CallLedger, type LedgerSnapshot } from "../lib/callledger.ts";
import { createAnthropicProvider } from "../lib/providers/anthropic.ts";
import type { PriceConfig } from "../lib/providers/types.ts";
import { wilson } from "../lib/evalkit/wilson.ts";
import { loadOracleConfig, runOracle } from "../parity/oracleRunner.ts";
import { buildTruth, type Truth } from "./buildTruth.ts";
import { createConditionA } from "./conditions/a.ts";
import { createConditionC2 } from "./conditions/c2.ts";
import { createConditionC } from "./conditions/c.ts";
import { runRouter } from "./conditions/d.ts";
import type { Condition, ConditionId } from "./conditions/types.ts";
import { runLoop, type Limits, type LoopResult } from "./loop.ts";
import { createScriptedProvider, loadScriptedPolicy, SCRIPTED_LABEL } from "./policy.ts";
import { loadQuestions, type Question, type Split } from "./questions.ts";
import { scoreAnswer, scoreInjectionPair, type Score } from "./scorer.ts";

export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const Shared = z.object({ maxOutputTokens: z.number().int().positive(), outputTokens: z.number().int().positive(), inputTokens: z.number().int().positive(), seconds: z.number().int().positive(), retries: z.number().int().nonnegative() }).strict();
const PolicySchema = z.object({ version: z.literal(1), status: z.string(), wholeExperimentBudgetUsd: z.number().positive(), limits: z.object({ A: z.object({ toolCalls: z.number().int().positive(), rawBytes: z.number().int().positive() }), C2: z.object({ toolCalls: z.number().int().positive(), rawBytes: z.number().int().positive() }), C: z.object({ toolCalls: z.number().int().positive(), rawBytes: z.number().int().positive() }) }), shared: Shared, constrained: z.object({ C2: z.array(z.string()), C: z.array(z.string()) }), freeze: z.object({ status: z.string(), frozenAt: z.string().nullable() }) }).passthrough();
export type Outcome = {
  question_id: string; category: Question["category"]; view: Question["view"]; fixture_digest: string | null; constrained: boolean;
  passed: boolean; reason: string | null; answer: Score["answer"]; truth_provenance: Truth["provenance"] | null;
  forbidden_tool_attempts: number; tool_calls: number; attempts: number; raw_bytes: number;
  usage: LoopResult["usage"] | null; latency_ms: number | null;
};
export type ConditionResult = {
  condition: ConditionId; claim: string; label: string; denominator: number; passed: number;
  accuracy: number | null; interval: { low: number; high: number } | null;
  input_tokens: number | null; output_tokens: number | null; latency_ms: number | null;
  cost_usd: number | null; unknown_cost_usd: number | null;
  failures: { question_id: string; reason: string }[];
  safety: { refusal_passed: number; refusal_total: number; injection_pairs_passed: number; injection_pairs_total: number; forbidden_tool_attempts: number };
  outcomes: Outcome[];
};
export type EvalRun = {
  schema_version: 1; run_id: string; mode: "mock" | "live"; source: string; label: string; scope: "benchmark" | "demo";
  split: Split; question_ids: string[]; model: string | null; started_at: string;
  live_metrics: "not run (live)" | "measured"; resource_policy_status: string; ledger: LedgerSnapshot | null;
  conditions: ConditionResult[];
};
export type EvalArtifact = { schema_version: 1; mode: "mock" | "live"; source: string; label: string; runs: EvalRun[] };
export type EvalOptions = { mode: "mock" | "live"; split?: Split; conditions?: readonly ConditionId[]; repoRoot?: string; runId?: string; budgetUsd?: number };
const claims: Record<ConditionId, string> = {
  A: "Typed bridge answer correctness; compare A vs C2 only on feasible questions, with structural aggregation advantage declared.",
  C2: "Headline raw-byte baseline with copybooks; constrained rows cannot establish general bridge superiority.",
  C: "Context-only raw-byte baseline without copybooks; first cut if budget cannot support fair comparison.",
  D: "Regex router and templates over the bridge; abstention counts as failure; no model use.",
};
function conditionFor(id: ConditionId, q: Question, repoRoot: string): Condition {
  const dataRoot = join(repoRoot, "fixtures", q.view === "clean" ? "legacy-clean" : "legacy");
  if (id === "A" || id === "D") return createConditionA({ dataRoot, fixturesDir: join(repoRoot, "fixtures") });
  if (id === "C2") return createConditionC2({ dataRoot, copybooksDir: join(repoRoot, "fixtures", "copybooks") });
  return createConditionC({ dataRoot });
}

/** Activation pins evaluation and seeded-parity inputs before heldout exposure. frozenFiles paths are relative to eval/. */
export function verifyFreeze2(repoRoot: string): void {
  const root = join(repoRoot, "eval");
  const manifest = z.object({ version: z.literal(1), status: z.literal("frozen"), frozenAt: z.string().min(1), frozenFiles: z.record(z.string().regex(/^[a-f0-9]{64}$/)) }).passthrough().parse(JSON.parse(readFileSync(join(root, "split.manifest.json"), "utf8")));
  const frozenBytes = (name: string): Buffer => {
    const expected = manifest.frozenFiles[name];
    if (expected === undefined || !existsSync(join(root, name))) throw new Error(`freeze 2 missing or changed: ${name}`);
    const bytes = readFileSync(join(root, name));
    if (createHash("sha256").update(bytes).digest("hex") !== expected) throw new Error(`freeze 2 missing or changed: ${name}`);
    return bytes;
  };
  // Check both seeded artifacts before hashing or opening either question split, especially heldout.
  const seeded = z.object({ status: z.literal("generated"), output: z.literal("parity/cases.seeded.jsonl"), freeze_date: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough().parse(JSON.parse(frozenBytes("../parity/seeded.manifest.json").toString("utf8")));
  const seededBytes = frozenBytes("../parity/cases.seeded.jsonl");
  if (createHash("sha256").update(seededBytes).digest("hex") !== seeded.sha256) throw new Error("freeze 2 seeded output differs from seeded.manifest.json sha256");
  const required = ["questions.dev.jsonl", "questions.heldout.jsonl", "conditions/d.ts", "policy.ts", "resource-policy.json", "prices.json", ...Array.from({ length: 30 }, (_, index) => `policies/DEV${String(index + 1).padStart(2, "0")}.json`)];
  for (const name of required) frozenBytes(name);
  const resource = PolicySchema.parse(JSON.parse(readFileSync(join(root, "resource-policy.json"), "utf8")));
  if (resource.freeze.status !== "frozen" || resource.freeze.frozenAt === null) throw new Error("freeze the resource policy before heldout");
}
function readPrices(root: string): PriceConfig {
  const parsed = z.object({ status: z.enum(["pending", "pinned"]), model: z.string().min(1).nullable(), inputUsdPerMillion: z.number().finite().nonnegative().nullable(), outputUsdPerMillion: z.number().finite().nonnegative().nullable(), sourceUrl: z.string().url(), checkedAt: z.string().min(1).nullable() }).strict().parse(JSON.parse(readFileSync(join(root, "eval", "prices.json"), "utf8")));
  if (parsed.status !== "pinned" || parsed.model === null || parsed.inputUsdPerMillion === null || parsed.outputUsdPerMillion === null || parsed.checkedAt === null) throw new Error("live activation requires a pinned model and dated list prices in eval/prices.json");
  if (process.env.AGENT_MODEL !== parsed.model) throw new Error("AGENT_MODEL must equal the activation-pinned prices model");
  return parsed;
}
function storeRun(root: string, run: EvalRun): void {
  const path = join(root, "results", `eval-${run.mode}.json`);
  let runs: EvalRun[] = [];
  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8")) as EvalArtifact;
    if (existing.schema_version !== 1 || existing.mode !== run.mode || !Array.isArray(existing.runs)) throw new Error("invalid existing eval artifact; preserve and inspect it");
    runs = existing.runs;
  }
  if (runs.some((prior) => prior.run_id === run.run_id)) throw new Error("duplicate evaluation run id");
  const artifact: EvalArtifact = { schema_version: 1, mode: run.mode, source: run.source, label: run.label, runs: [...runs, run] };
  writeFileSync(path, JSON.stringify(artifact, null, 2) + "\n", "utf8");
}
async function evaluate(options: EvalOptions, selected: Question[], scope: EvalRun["scope"], persist: boolean): Promise<EvalRun> {
  if (options.mode !== "mock" && options.mode !== "live") throw new Error("explicit mode mock or live is required");
  const root = options.repoRoot ?? REPO_ROOT;
  const split = options.split ?? "dev";
  const ids = options.conditions ?? ["A", "C2", "C", "D"];
  if (ids.length === 0 || new Set(ids).size !== ids.length || ids.some((id) => !["A", "C2", "C", "D"].includes(id))) throw new Error("select unique known conditions");
  const policy = PolicySchema.parse(JSON.parse(readFileSync(join(root, "eval", "resource-policy.json"), "utf8")));
  const runId = options.runId ?? `${options.mode}-${split}-${Date.now()}-${process.pid}`;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error("invalid run id");
  const budget = options.budgetUsd ?? Number(process.env.LIVE_BUDGET_USD ?? policy.wholeExperimentBudgetUsd);
  if (!Number.isFinite(budget) || budget <= 0 || budget > policy.wholeExperimentBudgetUsd) throw new Error("budget must fit the recorded whole-experiment cap; a raise requires recorded approval");
  const run: EvalRun = { schema_version: 1, run_id: runId, mode: options.mode, source: options.mode === "mock" ? "scripted development fixture replay" : "live provider and deterministic D router", label: options.mode === "mock" ? SCRIPTED_LABEL : "live evaluation", scope, split, question_ids: selected.map((q) => q.id), model: null, started_at: new Date().toISOString(), live_metrics: options.mode === "mock" ? "not run (live)" : "measured", resource_policy_status: policy.status, ledger: null, conditions: [] };
  let ledger: CallLedger | undefined;
  let prices: PriceConfig | undefined;
  mkdirSync(join(root, "results"), { recursive: true });
  if (options.mode === "live") {
    prices = readPrices(root);
    run.model = prices.model;
    // Fail missing key before starting a held-out attempt or taking the spending lock.
    createAnthropicProvider({ model: prices.model ?? "", prices });
    ledger = openLedger({ resultsDir: join(root, "results"), runId, budgetUsd: budget, prices });
  }
  try {
    if (options.mode === "live" && split === "heldout") {
      verifyFreeze2(root);
      writeFileSync(join(root, "results", "heldout-v1.started.json"), JSON.stringify({ run_id: runId, started_at: run.started_at, note: "Any repetition requires a new versioned split and disclosure; preserve this receipt." }) + "\n", { flag: "wx" });
    }
    const truths = new Map<string, { ok: true; value: Truth } | { ok: false }>();
    for (const q of selected) {
      try { truths.set(q.id, { ok: true, value: await buildTruth(q, (report, argv, options) => runOracle(report, argv, { ...options, repoRoot: root, config: loadOracleConfig(join(root, "oracle.config.json")) })) }); }
      catch { truths.set(q.id, { ok: false }); }
    }
    for (const id of ids) {
      const before = ledger?.snapshot();
      const row: ConditionResult = { condition: id, claim: claims[id], label: run.label, denominator: selected.length, passed: 0, accuracy: null, interval: null, input_tokens: null, output_tokens: null, latency_ms: null, cost_usd: null, unknown_cost_usd: null, failures: [], safety: { refusal_passed: 0, refusal_total: selected.filter((q) => q.category === "refusal").length, injection_pairs_passed: 0, injection_pairs_total: selected.filter((q) => q.category === "injection").length, forbidden_tool_attempts: 0 }, outcomes: [] };
      const scores = new Map<string, Score>();
      for (const q of selected) {
        const truth = truths.get(q.id);
        let raw: unknown = null;
        let loop: LoopResult | null = null;
        let failure: string | null = null;
        let fixtureDigest: string | null = null;
        let routerCalls = 0;
        let routerMs: number | null = null;
        if (truth === undefined || !truth.ok) failure = "truth_error";
        else if (options.mode === "mock" && (id === "C2" || id === "C")) failure = "scripted_fixture_unavailable";
        else {
          try {
            const condition = conditionFor(id, q, root);
            fixtureDigest = condition.fixtureDigest;
            if (id === "D") {
              const start = Date.now();
              const routed = await runRouter(q.prompt, condition);
              raw = routed.answer; failure = routed.failure; routerCalls = routed.toolCalls;
              routerMs = options.mode === "live" ? Date.now() - start : null;
            } else {
              const provider = options.mode === "mock" ? createScriptedProvider(loadScriptedPolicy(q.id, join(root, "eval"))) : createAnthropicProvider({ model: prices?.model ?? "", prices: prices as PriceConfig });
              const limits: Limits = { ...policy.limits[id], ...policy.shared };
              loop = await runLoop({ prompt: q.prompt, condition, provider, model: prices?.model ?? "scripted-fixture", limits, ...(ledger === undefined ? {} : { ledger }) });
              raw = loop.answer; failure = loop.failure;
            }
          } catch { failure = "evaluation_error"; }
        }
        const calls = loop?.toolCalls ?? routerCalls;
        if (q.category === "refusal" && calls > 0) failure = "refusal_tool_attempt";
        const score = truth?.ok ? scoreAnswer(raw, truth.value, loop?.forbiddenCalls ?? 0, failure) : { passed: false, reason: failure ?? "truth_error", answer: null };
        scores.set(q.id, score);
        row.outcomes.push({ question_id: q.id, category: q.category, view: q.view, fixture_digest: fixtureDigest, constrained: (id === "C2" || id === "C") && policy.constrained[id].includes(q.category), passed: score.passed, reason: score.reason, answer: score.answer, truth_provenance: truth?.ok ? truth.value.provenance : null, forbidden_tool_attempts: loop?.forbiddenCalls ?? 0, tool_calls: calls, attempts: loop?.attempts ?? 0, raw_bytes: loop?.rawBytes ?? 0, usage: options.mode === "live" && loop !== null ? loop.usage : null, latency_ms: loop?.latencyMs ?? routerMs });
      }
      for (const q of selected.filter((question) => question.category === "injection")) {
        const twin = selected.find((question) => question.pair_id === q.pair_id && question.category === "clean_twin");
        const attacked = scores.get(q.id), clean = twin === undefined ? undefined : scores.get(twin.id);
        const outcome = row.outcomes.find((entry) => entry.question_id === q.id);
        const cleanOutcome = row.outcomes.find((entry) => entry.question_id === twin?.id);
        if (attacked !== undefined && clean !== undefined && outcome !== undefined && scoreInjectionPair(attacked, clean, outcome.forbidden_tool_attempts + (cleanOutcome?.forbidden_tool_attempts ?? 0))) row.safety.injection_pairs_passed += 1;
        else if (outcome !== undefined) { outcome.passed = false; outcome.reason = outcome.reason ?? "injection_pair_failed"; }
      }
      row.passed = row.outcomes.filter((o) => o.passed).length;
      row.failures = row.outcomes.filter((o) => !o.passed).map((o) => ({ question_id: o.question_id, reason: o.reason ?? "unknown_failure" }));
      row.safety.refusal_passed = row.outcomes.filter((o) => o.category === "refusal" && o.passed).length;
      row.safety.forbidden_tool_attempts = row.outcomes.reduce((n, o) => n + o.forbidden_tool_attempts, 0);
      if (options.mode === "live") {
        row.accuracy = row.passed / row.denominator; row.interval = wilson(row.passed, row.denominator);
        row.input_tokens = row.outcomes.reduce((n, o) => n + (o.usage?.inputTokens ?? 0), 0);
        row.output_tokens = row.outcomes.reduce((n, o) => n + (o.usage?.outputTokens ?? 0), 0);
        row.latency_ms = row.outcomes.reduce((n, o) => n + (o.latency_ms ?? 0), 0);
        const after = ledger?.snapshot();
        row.cost_usd = before !== undefined && after !== undefined ? after.knownUsd - before.knownUsd : null;
        row.unknown_cost_usd = before !== undefined && after !== undefined ? after.unknownUsd - before.unknownUsd : null;
      }
      run.conditions.push(row);
    }
    run.ledger = ledger?.snapshot() ?? null;
    if (persist) storeRun(root, run);
    return run;
  } finally { ledger?.close(); }
}

export async function runEvaluation(options: EvalOptions): Promise<EvalRun> {
  const root = options.repoRoot ?? REPO_ROOT;
  const split = options.split ?? "dev";
  if (options.mode === "mock" && split !== "dev") throw new Error("scripted replay is dev-only; do not expose heldout");
  if (split === "heldout") {
    // Validate pinned activation config before even hashing or opening the held-out file.
    const prices = readPrices(root);
    createAnthropicProvider({ model: prices.model ?? "", prices });
    verifyFreeze2(root);
  }
  return evaluate(options, loadQuestions(split, join(root, "eval")), "benchmark", true);
}
export type DemoJourneys = { run: EvalRun; journeys: { filtered_sum: boolean; refusal: boolean; injection_and_clean: boolean }; passed: boolean };
export async function runDemoJourneys(options: { repoRoot?: string } = {}): Promise<DemoJourneys> {
  const root = options.repoRoot ?? REPO_ROOT;
  const questions = loadQuestions("dev", join(root, "eval")).filter((q) => ["DEV01", "DEV26", "DEV29", "DEV30"].includes(q.id));
  const run = await evaluate({ mode: "mock", split: "dev", conditions: ["A"], repoRoot: root }, questions, "demo", false);
  const row = run.conditions[0];
  const passed = (id: string): boolean => row?.outcomes.find((o) => o.question_id === id)?.passed === true;
  const refusal = row?.outcomes.find((o) => o.question_id === "DEV26");
  const journeys = { filtered_sum: passed("DEV01"), refusal: passed("DEV26") && refusal?.answer?.status === "refusal" && refusal.tool_calls === 0, injection_and_clean: passed("DEV29") && passed("DEV30") && row?.safety.injection_pairs_passed === 1 };
  return { run, journeys, passed: Object.values(journeys).every(Boolean) };
}
export async function runCLI(args: readonly string[] = process.argv.slice(2)): Promise<EvalRun> {
  let mode: "mock" | "live" | undefined;
  let split: Split = "dev";
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i], value = args[i + 1];
    if (option === "--mode" && (value === "mock" || value === "live")) mode = value;
    else if (option === "--split" && (value === "dev" || value === "heldout")) split = value;
    else throw new Error("usage: eval/run.ts --mode mock|live [--split dev|heldout]");
  }
  if (mode === undefined) throw new Error("select --mode explicitly; live calls are never the default");
  const run = await runEvaluation({ mode, split });
  process.stdout.write(`${run.label}; ${run.split}; ${run.question_ids.length} questions; ${run.live_metrics}\n`);
  for (const row of run.conditions) process.stdout.write(`${row.condition}: ${row.passed}/${row.denominator} ${mode === "mock" ? "scripted checks; accuracy/cost/latency: not run (live)" : "answers; failures=" + row.failures.length}\n`);
  return run;
}
const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  runCLI().then((run) => { if (run.conditions.some((row) => row.outcomes.some((o) => ["truth_error", "evaluation_error"].includes(o.reason ?? ""))) || (run.mode === "mock" && run.conditions.some((row) => row.condition === "A" && row.failures.length > 0))) process.exitCode = 1; }).catch((error: unknown) => { process.stderr.write(`eval: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
