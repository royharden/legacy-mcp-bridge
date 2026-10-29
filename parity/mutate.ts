// Mutation experiment: baseline first; one override set at a time; semantic and schema-only suites stay separate.
// Imports of the test-only catalogue are contained here and caught so import failures become invalid experiments.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createBridge, type Bridge, type BridgeOps, type ToolResult } from "../src/bridge/createBridge.ts";
import { loadCaseFile, type ParityCase } from "./caseSchema.ts";
import { CASE_FILES, runCases, type CaseResult, type RunOptions, type RunReport } from "./harness.ts";
import { REPO_ROOT, type OracleView } from "./oracleRunner.ts";
import { MUTANT_NAMES, TOOL_NAMES } from "./projections.ts";

export const SUITES = ["full", "smoke", "schema-only"] as const;
export type Suite = (typeof SUITES)[number];
export type MutationOutcome = "killed" | "survived" | "invalid" | "not_executed";
export type MutationResult = { outcome: MutationOutcome; case_ids: string[]; reason: string };
export type MutantDefinition = { name: string; ops: Partial<BridgeOps> };
export type MutationBridgeOptions = { view: OracleView; capBytes?: number; ops?: Partial<BridgeOps> };
export type MutationBridgeFactory = (opts: MutationBridgeOptions) => Bridge | Promise<Bridge>;
export type MutantRunnerOptions = {
  cases?: readonly ParityCase[];
  suites?: readonly Suite[];
  parityOptions?: Omit<RunOptions, "bridgeFactory">;
  bridgeFactory?: MutationBridgeFactory;
  /** Deterministic seams for runner tests; production uses runCases and the isolated catalogue below. */
  parityRunner?: typeof runCases;
  mutantLoader?: () => Promise<readonly MutantDefinition[]>;
};
export type MutantReport = {
  version: 1;
  notes: string[];
  selected_suites: Suite[];
  case_ids: string[];
  case_count: number;
  seeded_status: "available" | "pending_generation" | "provided_cases";
  baseline: Partial<Record<Suite, RunReport>>;
  mutants: Array<{ name: string; trap_case_ids: string[]; suites: Record<Suite, MutationResult> }>;
  counts: Record<Suite, Record<MutationOutcome, number>>;
  /** Full-suite survivors fail the proposed detection target; smoke/schema survivors are legitimate observations. */
  pass: boolean;
};

const ERROR_CODES = new Set(["bad_argument", "not_found", "invalid_cursor", "over_cap", "path_rejected", "unknown_tool", "internal"]);
const notExecuted = (reason: string): MutationResult => ({ outcome: "not_executed", case_ids: [], reason });
const invalid = (reason: string): MutationResult => ({ outcome: "invalid", case_ids: [], reason });
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function loadMutantDefinitions(): Promise<readonly MutantDefinition[]> {
  const { MUTANTS } = await import("../src/bridge/mutants.ts");
  validateMutantDefinitions(MUTANTS);
  return MUTANTS;
}

export function validateMutantDefinitions(defs: readonly MutantDefinition[]): void {
  const names = defs.map((d) => d.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...MUTANT_NAMES].sort())) throw new Error("mutant catalogue must contain exactly the twelve spec names");
  for (const def of defs) {
    const keys = Object.keys(def.ops);
    if (keys.length !== 1 || typeof Object.values(def.ops)[0] !== "function") {
      throw new Error(`mutant ${def.name} must override exactly one operation`);
    }
  }
}

function completeReport(report: RunReport, ids: readonly string[]): boolean {
  const got = report.results.map((r) => r.id).sort();
  return new Set(got).size === got.length && JSON.stringify(got) === JSON.stringify([...ids].sort());
}

/** A complete passing baseline is mandatory; any infrastructure failure invalidates the entire mutant/suite cell. */
export function classifyMutation(baseline: RunReport | null, mutated: RunReport | null, ids: readonly string[]): MutationResult {
  if (ids.length === 0 || baseline === null || !completeReport(baseline, ids) || !baseline.pass || baseline.results.some((r) => !r.pass || r.outcome !== "pass")) {
    return notExecuted("missing, incomplete or failing unmutated baseline");
  }
  if (mutated === null || !completeReport(mutated, ids)) return invalid("missing or incomplete mutated run");
  const infra = mutated.results.filter((r) => r.outcome === "infra_error" || r.infra !== null);
  if (infra.length > 0) return { outcome: "invalid", case_ids: infra.map((r) => r.id), reason: "infrastructure failure; never counted as detection" };
  const killed = mutated.results.filter((r) => r.outcome === "diff" || r.outcome === "bridge_error");
  if (killed.length > 0) return { outcome: "killed", case_ids: killed.map((r) => r.id), reason: "behaviour or schema differs on baseline-passing cases" };
  // A bridge error may make a tax-id tolerance unused; it is already a behavioural kill above. An unexplained
  // tolerance-only failure or inconsistent runner status is an invalid experiment instead of a fabricated kill.
  if (!mutated.pass || mutated.toleranceProblems.length > 0 || mutated.results.some((r) => !r.pass || r.outcome !== "pass")) {
    return invalid("non-behavioural run failure");
  }
  return { outcome: "survived", case_ids: [], reason: "all selected checks passed" };
}

export function defaultMutationBridgeFactory(opts: MutationBridgeOptions): Bridge {
  return createBridge({
    dataRoot: join(REPO_ROOT, "fixtures", opts.view === "clean" ? "legacy-clean" : "legacy"),
    auditPath: null,
    ...(opts.capBytes === undefined ? {} : { capBytes: opts.capBytes }),
    ...(opts.ops === undefined ? {} : { ops: opts.ops }),
  });
}

function schemaProblem(bridge: Bridge, tool: string, result: ToolResult): string | null {
  if (!result.ok) {
    const error = result.error;
    return ERROR_CODES.has(error.code) && typeof error.message === "string" && error.message.length > 0 &&
      (error.field === undefined || typeof error.field === "string") ? null : "malformed structured error";
  }
  const def = bridge.tools.find((t) => t.name === tool);
  if (def === undefined) return "success from an unregistered tool";
  if (!def.outputSchema.safeParse(result.structured).success) return "output schema rejected structured content";
  try {
    if (JSON.stringify(JSON.parse(result.text)) !== JSON.stringify(result.structured)) return "text differs from structured content";
  } catch {
    return "text content is not JSON";
  }
  return null;
}

function schemaResult(c: ParityCase, view: OracleView): CaseResult {
  return {
    id: c.id, kind: c.kind, tool: c.tool, projection: c.projection, view, tags: c.tags,
    outcome: "pass", pass: true, diffs: [], matched: [], ignored: [], divergences: [],
    tolerancesUsed: [], bridgeError: null, infra: null, pages: 0,
  };
}

/** Protocol/schema baseline: exactly five definitions, output validation and matching JSON text or a typed error.
 * It deliberately checks no oracle, expectation literals, semantic equality, paging union or masking beyond schemas.
 * An internal typed error is schema-valid; therefore schema-only may survive a mutant the parity suite kills.
 */
export async function runSchemaOnly(cases: readonly ParityCase[], bridgeFactory: MutationBridgeFactory, ops?: Partial<BridgeOps>, viewOverride?: OracleView): Promise<RunReport> {
  const results: CaseResult[] = [];
  const bridges = new Map<string, Promise<Bridge>>();
  for (const c of cases) {
    const view = viewOverride ?? c.view;
    const r = schemaResult(c, view);
    results.push(r);
    const key = `${view}|${c.cap_bytes ?? ""}`;
    let bridge: Bridge;
    try {
      let pending = bridges.get(key);
      if (pending === undefined) {
        pending = Promise.resolve().then(() => bridgeFactory({ view,
          ...(c.cap_bytes === undefined ? {} : { capBytes: c.cap_bytes }),
          ...(ops === undefined ? {} : { ops }),
        }));
        bridges.set(key, pending);
      }
      bridge = await pending;
    } catch (error) {
      r.pass = false; r.outcome = "infra_error"; r.infra = { stage: "bridge_factory", message: message(error) };
      continue;
    }
    try {
      const names = bridge.tools.map((t) => t.name).sort();
      let problem = JSON.stringify(names) === JSON.stringify([...TOOL_NAMES].sort()) ? null : "tool list differs from the five registered definitions";
      const args = c.paging === null ? c.args : { ...c.args, limit: c.paging.limit };
      const result = await bridge.call(c.tool, args);
      r.pages = 1;
      problem ??= schemaProblem(bridge, c.tool, result);
      if (problem !== null) {
        r.pass = false; r.outcome = "diff";
        r.diffs.push({ case: c.id, field: "schema/protocol", bridge: "invalid", oracle: "not consulted", pointer: null, message: problem });
      }
    } catch (error) {
      r.pass = false; r.outcome = "infra_error"; r.infra = { stage: "bridge_call", message: message(error) };
    }
  }
  const passed = results.filter((r) => r.pass).length;
  return { results, toleranceProblems: [], passed, failed: results.length - passed, pass: cases.length > 0 && passed === cases.length };
}

export async function runMutants(options: MutantRunnerOptions = {}): Promise<MutantReport> {
  const notes = ["schema-only validates protocol/schemas, not oracle semantics or literal expectations; typed internal errors are schema-valid"];
  const cases = options.cases === undefined ? [
    ...loadCaseFile(CASE_FILES.trap),
    ...(existsSync(CASE_FILES.seeded) ? loadCaseFile(CASE_FILES.seeded) : []),
  ] : [...options.cases];
  if (options.cases === undefined && !existsSync(CASE_FILES.seeded)) notes.push("seeded set pending generation: full suite covers the trap set only");
  const suites = [...new Set(options.suites ?? SUITES)];
  if (suites.length === 0 || suites.some((s) => !(SUITES as readonly string[]).includes(s))) throw new Error("select at least one known mutation suite");
  const smoke = cases.filter((c) => c.tags.includes("smoke"));
  const suiteCases: Record<Suite, ParityCase[]> = { full: cases, smoke, "schema-only": cases };
  const factory = options.bridgeFactory ?? defaultMutationBridgeFactory;
  const parityRunner = options.parityRunner ?? runCases;
  const parityOptions = options.parityOptions ?? {};
  const execute = (suite: Suite, ops?: Partial<BridgeOps>): Promise<RunReport> => suite === "schema-only" ?
    runSchemaOnly(suiteCases[suite], factory, ops, parityOptions.view) :
    parityRunner(suiteCases[suite], { ...parityOptions, bridgeFactory: (opts) => factory({ ...opts, ...(ops === undefined ? {} : { ops }) }) });
  const baseline: Partial<Record<Suite, RunReport>> = {};
  const baselineErrors = new Map<Suite, string>();
  for (const suite of suites) {
    if (suite === "smoke" && smoke.length !== 5) {
      baselineErrors.set(suite, `expected exactly five smoke cases, found ${smoke.length}`);
      continue;
    }
    try { baseline[suite] = await execute(suite); }
    catch (error) { baselineErrors.set(suite, message(error)); }
  }
  let defs: readonly MutantDefinition[] = [];
  let catalogueError: string | null = null;
  try {
    defs = await (options.mutantLoader ?? loadMutantDefinitions)();
    validateMutantDefinitions(defs);
  } catch (error) { catalogueError = message(error); }
  for (const [suite, error] of baselineErrors) notes.push(`${suite} baseline: ${error}`);
  if (catalogueError !== null) notes.push(`mutant catalogue unavailable: ${catalogueError}`);
  const mutants: MutantReport["mutants"] = [];
  for (const name of MUTANT_NAMES) {
    const cells: Record<Suite, MutationResult> = {
      full: notExecuted("suite not selected"), smoke: notExecuted("suite not selected"), "schema-only": notExecuted("suite not selected"),
    };
    const trap_case_ids = cases.filter((c) => c.tags.includes(`mutant:${name}`)).map((c) => c.id);
    const def = defs.find((d) => d.name === name);
    for (const suite of suites) {
      const selected = suiteCases[suite];
      const ids = selected.map((c) => c.id);
      const base = baseline[suite] ?? null;
      const gate = classifyMutation(base, null, ids);
      if (gate.outcome === "not_executed") cells[suite] = gate;
      else if (catalogueError !== null || def === undefined) cells[suite] = invalid("mutant catalogue import/validation failed");
      else if (trap_case_ids.length === 0) cells[suite] = invalid("mutant has no trap-tag mapping in the full suite");
      else {
        try { cells[suite] = classifyMutation(base, await execute(suite, def.ops), ids); }
        catch (error) { cells[suite] = invalid(`runner failure: ${message(error)}`); }
      }
    }
    mutants.push({ name, trap_case_ids, suites: cells });
  }
  const emptyCounts = (): Record<MutationOutcome, number> => ({ killed: 0, survived: 0, invalid: 0, not_executed: 0 });
  const counts: MutantReport["counts"] = { full: emptyCounts(), smoke: emptyCounts(), "schema-only": emptyCounts() };
  for (const mutant of mutants) for (const suite of SUITES) counts[suite][mutant.suites[suite].outcome]++;
  const pass = suites.every((suite) => {
    const base = baseline[suite];
    return base !== undefined && classifyMutation(base, base, suiteCases[suite].map((c) => c.id)).outcome === "survived" &&
      mutants.every((m) => suite === "full" ? m.suites[suite].outcome === "killed" : ["killed", "survived"].includes(m.suites[suite].outcome));
  });
  const seeded_status = options.cases !== undefined ? "provided_cases" : existsSync(CASE_FILES.seeded) ? "available" : "pending_generation";
  return { version: 1, notes, selected_suites: suites, case_ids: cases.map((c) => c.id), case_count: cases.length, seeded_status, baseline, mutants, counts, pass };
}

async function main(): Promise<void> {
  let output = join(REPO_ROOT, "results", "mutants.json");
  let suites: Suite[] = [...SUITES];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--smoke") suites = ["smoke"];
    else if (arg === "--suite") {
      const value = argv[++i];
      if (!(SUITES as readonly (string | undefined)[]).includes(value)) throw new Error("--suite takes full, smoke or schema-only");
      suites = [value as Suite];
    } else if (arg === "--json") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("--json takes an output path");
      output = resolve(value);
    } else throw new Error(`unknown argument ${String(arg)}`);
  }
  const report = await runMutants({ suites });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  for (const note of report.notes) process.stdout.write(`NOTE ${note}\n`);
  for (const m of report.mutants) {
    process.stdout.write(`${m.name}: ${report.selected_suites.map((s) => `${s}=${m.suites[s].outcome} [${m.suites[s].case_ids.join(",")}]`).join("; ")}\n`);
  }
  for (const suite of suites) process.stdout.write(`${suite}: ${JSON.stringify(report.counts[suite])}\n`);
  process.stdout.write(`mutants: wrote ${output}\n`);
  process.exitCode = report.pass ? 0 : 1;
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  main().catch((error: unknown) => { process.stderr.write(`mutants: ${message(error)}\n`); process.exitCode = 1; });
}
