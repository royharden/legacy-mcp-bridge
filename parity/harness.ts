// parity/harness.ts — the parity harness. CLI: `node --experimental-strip-types parity/harness.ts [--set trap|seeded|all]
// [--json [out]]`. Library: `runCases(cases, { bridgeFactory, view?, oracle?, tolerances? })`, used by parity/mutate.ts
// (M4) to inject a mutant bridge. Per case: run the oracle (child process) and parse its report, call the bridge (paging
// with the harness's own cursor loop — never bridge helpers), compare through the case's projection, then match the
// case's literal expectations. Outcomes: pass | diff | bridge_error (a structured bridge error the oracle does not
// explain) | infra_error (oracle, parser or bridge-construction failure; never a pass).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createBridge, type Bridge, type ToolResult } from "../src/bridge/createBridge.ts";
import { loadCaseFile, oracleCalls, type ParityCase } from "./caseSchema.ts";
import { compare, type Applied, type BridgeObservation, type Diff } from "./comparator.ts";
import { OracleError, REPO_ROOT, runOracle, type OracleView } from "./oracleRunner.ts";
import { redactParityValue } from "./projections.ts";
import { loadPrintspec, parseReport, ReportParseError, type ParsedReport, type Printspec } from "./reportParser.ts";
import { loadTolerances, unusedTolerances, type Tolerance, type ToleranceUse } from "./tolerances.ts";

export const CASE_FILES = {
  trap: join(REPO_ROOT, "parity", "cases.trap.jsonl"),
  seeded: join(REPO_ROOT, "parity", "cases.seeded.jsonl"),
} as const;

export type BridgeFactory = (opts: { view: OracleView; capBytes?: number }) => Bridge | Promise<Bridge>;
export type OracleFn = (report: string, argv: readonly string[], view: OracleView) => Promise<{ stdout: string }>;

export type RunOptions = {
  bridgeFactory: BridgeFactory;
  /** Forces one dataset view for every case (default: each case's own view). */
  view?: OracleView;
  /** Oracle override (tests); default runs the configured legacy program. */
  oracle?: OracleFn;
  /** Default: parity/tolerances.json validated against the case ids on disk plus these cases. */
  tolerances?: Tolerance[];
  printspec?: Printspec;
  /** Safety bound for the union cursor loop. */
  maxPages?: number;
};

export type Outcome = "pass" | "diff" | "bridge_error" | "infra_error";

export type CaseResult = {
  id: string;
  kind: ParityCase["kind"];
  tool: string;
  projection: string | null;
  view: OracleView;
  tags: string[];
  outcome: Outcome;
  pass: boolean;
  diffs: Diff[];
  matched: string[];
  ignored: Applied[];
  divergences: Applied[];
  tolerancesUsed: ToleranceUse[];
  bridgeError: { code: string; message: string } | null;
  infra: { stage: "oracle" | "parse" | "bridge_factory" | "bridge_call" | "comparator"; message: string } | null;
  pages: number;
};

export type RunReport = {
  results: CaseResult[];
  /** Stale tolerance declarations for cases that ran (an error: the run fails). */
  toleranceProblems: string[];
  passed: number;
  failed: number;
  pass: boolean;
};

// ---------------------------------------------------------------- literal expectations

const MATCHER_KEYS = new Set(["$type", "$len", "$min", "$max", "$absent"]);

function isMatcher(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => MATCHER_KEYS.has(k));
}

function typeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function shown(path: string, v: unknown): string {
  if (v === undefined) return "(absent)";
  return JSON.stringify(redactParityValue(v, path)) ?? String(v);
}

/** Deep-partial match of a literal expectation; returns [path, actual, expected, reason] per mismatch. */
export function matchExpect(expected: unknown, actual: unknown, path = ""): Array<[string, unknown, unknown, string]> {
  const at = path === "" ? "(result)" : path;
  if (isMatcher(expected)) {
    const out: Array<[string, unknown, unknown, string]> = [];
    if (expected.$absent === true) return actual === undefined ? [] : [[at, actual, expected, "must be absent"]];
    if (actual === undefined) return [[at, actual, expected, "missing"]];
    if (typeof expected.$type === "string" && typeName(actual) !== expected.$type) out.push([at, actual, expected, `type ${typeName(actual)}`]);
    if (typeof expected.$len === "number") {
      const len = Array.isArray(actual) || typeof actual === "string" ? actual.length : -1;
      if (len !== expected.$len) out.push([at, actual, expected, `length ${len}`]);
    }
    if (typeof expected.$min === "number" && !(typeof actual === "number" && actual >= expected.$min)) out.push([at, actual, expected, "below $min"]);
    if (typeof expected.$max === "number" && !(typeof actual === "number" && actual <= expected.$max)) out.push([at, actual, expected, "above $max"]);
    return out;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [[at, actual, expected, "not an array"]];
    if (actual.length !== expected.length) return [[at, actual.length, expected.length, "array length differs"]];
    return expected.flatMap((e, i) => matchExpect(e, actual[i], `${path}[${i}]`));
  }
  if (typeof expected === "object" && expected !== null) {
    if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return [[at, actual, expected, "not an object"]];
    const a = actual as Record<string, unknown>;
    return Object.entries(expected).flatMap(([k, e]) => matchExpect(e, a[k], path === "" ? k : `${path}.${k}`));
  }
  return Object.is(expected, actual) ? [] : [[at, actual, expected, "differs from the literal"]];
}

function expectDiffs(c: ParityCase, target: unknown): Diff[] {
  if (c.expect === null) return [];
  return matchExpect(c.expect, target).map(([path, actual, expected, reason]) => ({
    case: c.id,
    field: `expect:${path}`,
    bridge: shown(path, actual),
    oracle: `literal ${shown(path, expected)}`,
    pointer: null,
    message: `expect: ${reason}`,
  }));
}

function expectTarget(results: readonly ToolResult[], union: boolean): unknown {
  const first = results[0];
  if (first === undefined) return {};
  if (!first.ok) return { error: first.error };
  if (!union) return first.structured;
  const rows = results.reduce((n, r) => n + (r.ok && Array.isArray(r.structured.data) ? r.structured.data.length : 0), 0);
  return { ...first.structured, union: { pages: results.length, rows } };
}

// ---------------------------------------------------------------- bridge calls (harness-owned paging)

async function observe(
  bridge: Bridge,
  c: ParityCase,
  maxPages: number,
): Promise<BridgeObservation> {
  if (c.paging === null) return { results: [await bridge.call(c.tool, c.args)] };
  const limit = c.paging.limit;
  if (!c.paging.union) return { results: [await bridge.call(c.tool, { ...c.args, limit })] };
  const results: ToolResult[] = [];
  const problems: string[] = [];
  const cursors = new Set<string>();
  let args: Record<string, unknown> = { ...c.args, limit };
  for (;;) {
    if (results.length >= maxPages) {
      problems.push(`stopped after ${maxPages} pages`);
      break;
    }
    const r = await bridge.call(c.tool, args);
    results.push(r);
    if (!r.ok) break;
    const rows = Array.isArray(r.structured.data) ? r.structured.data.length : 0;
    if (!Array.isArray(r.structured.data)) problems.push(`page ${results.length}: data is not an array`);
    if (rows > limit) problems.push(`page ${results.length}: ${rows} rows exceed limit ${limit}`);
    const next = r.structured.next_cursor;
    if (r.structured.truncated !== (next !== null)) {
      problems.push(`page ${results.length}: truncated must equal whether next_cursor is present`);
    }
    if (next === null) break;
    if (typeof next !== "string" || next === "") {
      problems.push(`page ${results.length}: next_cursor is not a token`);
      break;
    }
    if (rows === 0) {
      problems.push(`page ${results.length}: zero rows with a cursor (no progress)`);
      break;
    }
    if (cursors.has(next)) {
      problems.push(`page ${results.length}: cursor repeats`);
      break;
    }
    cursors.add(next);
    args = { ...c.args, limit, cursor: next };
  }
  return { results, pagingProblems: problems };
}

// ---------------------------------------------------------------- run

function emptyResult(c: ParityCase, view: OracleView): CaseResult {
  return {
    id: c.id,
    kind: c.kind,
    tool: c.tool,
    projection: c.projection,
    view,
    tags: c.tags,
    outcome: "infra_error",
    pass: false,
    diffs: [],
    matched: [],
    ignored: [],
    divergences: [],
    tolerancesUsed: [],
    bridgeError: null,
    infra: null,
    pages: 0,
  };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Case ids present in the case files on disk (for tolerance validation). */
export function caseIdsOnDisk(): Set<string> {
  const ids = new Set<string>();
  for (const f of Object.values(CASE_FILES)) {
    if (existsSync(f)) for (const c of loadCaseFile(f)) ids.add(c.id);
  }
  return ids;
}

export async function runCases(cases: readonly ParityCase[], opts: RunOptions): Promise<RunReport> {
  const printspec = opts.printspec ?? loadPrintspec();
  const tolerances =
    opts.tolerances ?? loadTolerances(new Set([...caseIdsOnDisk(), ...cases.map((c) => c.id)]));
  const oracle: OracleFn = opts.oracle ?? ((report, argv, view) => runOracle(report, argv, { view }));
  const maxPages = opts.maxPages ?? 1000;
  const bridges = new Map<string, Promise<Bridge>>();
  const getBridge = (view: OracleView, capBytes: number | undefined): Promise<Bridge> => {
    const key = `${view}|${capBytes ?? ""}`;
    let b = bridges.get(key);
    if (b === undefined) {
      b = Promise.resolve().then(() => opts.bridgeFactory(capBytes === undefined ? { view } : { view, capBytes }));
      bridges.set(key, b);
    }
    return b;
  };

  const results: CaseResult[] = [];
  for (const c of cases) {
    const view: OracleView = opts.view ?? c.view;
    const res = emptyResult(c, view);
    results.push(res);

    // Oracle first (parity only): a process or parse failure fails the case before the bridge is consulted.
    const parsed: ParsedReport[] = [];
    if (c.kind === "parity") {
      try {
        for (const call of oracleCalls(c)) {
          const { stdout } = await oracle(call.report, call.argv, view);
          try {
            parsed.push(parseReport(call.report, stdout, printspec));
          } catch (e) {
            res.infra = { stage: "parse", message: message(e) };
            break;
          }
        }
      } catch (e) {
        res.infra = { stage: "oracle", message: e instanceof OracleError ? `${e.kind}: ${e.message}` : message(e) };
      }
      if (res.infra !== null) continue;
    }

    let bridge: Bridge;
    try {
      bridge = await getBridge(view, c.cap_bytes);
    } catch (e) {
      res.infra = { stage: "bridge_factory", message: message(e) };
      continue;
    }
    let obs: BridgeObservation;
    try {
      obs = await observe(bridge, c, maxPages);
    } catch (e) {
      res.infra = { stage: "bridge_call", message: message(e) };
      continue;
    }
    res.pages = obs.results.length;
    const exp = expectDiffs(c, expectTarget(obs.results, c.paging?.union === true));

    if (c.kind === "contract") {
      res.diffs = [...(obs.pagingProblems ?? []).map((p) => pagingDiff(c, p)), ...exp];
      res.outcome = res.diffs.length === 0 ? "pass" : "diff";
      res.pass = res.outcome === "pass";
      continue;
    }

    try {
      const cmp = compare({ ...c, view }, obs, parsed, tolerances);
      res.diffs = [...cmp.diffs, ...exp];
      res.matched = cmp.matched;
      res.ignored = cmp.ignored;
      res.divergences = cmp.divergences;
      res.tolerancesUsed = cmp.tolerancesUsed;
      res.bridgeError = cmp.bridgeError;
      res.outcome = cmp.bridgeError !== null ? "bridge_error" : res.diffs.length > 0 ? "diff" : "pass";
      res.pass = res.outcome === "pass";
    } catch (e) {
      res.infra = { stage: "comparator", message: message(e) };
    }
  }

  const ran = new Set(results.map((r) => r.id));
  const toleranceProblems = unusedTolerances(tolerances, ran, results.flatMap((r) => r.tolerancesUsed));
  const passed = results.filter((r) => r.pass).length;
  return {
    results,
    toleranceProblems,
    passed,
    failed: results.length - passed,
    pass: passed === results.length && toleranceProblems.length === 0,
  };
}

function pagingDiff(c: ParityCase, p: string): Diff {
  return { case: c.id, field: "rows", bridge: p, oracle: "(contract)", pointer: null, message: "paging" };
}

// ---------------------------------------------------------------- CLI

export function defaultBridgeFactory(opts: { view: OracleView; capBytes?: number }): Bridge {
  const dataRoot = join(REPO_ROOT, "fixtures", opts.view === "clean" ? "legacy-clean" : "legacy");
  return createBridge(opts.capBytes === undefined ? { dataRoot, auditPath: null } : { dataRoot, auditPath: null, capBytes: opts.capBytes });
}

type CliArgs = { set: "trap" | "seeded" | "all"; json: string | null };

function parseCli(argv: readonly string[]): CliArgs {
  const out: CliArgs = { set: "all", json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--set") {
      const v = argv[++i];
      if (v !== "trap" && v !== "seeded" && v !== "all") throw new Error("--set takes trap, seeded or all");
      out.set = v;
    } else if (a === "--json") {
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("--")) {
        out.json = v;
        i++;
      } else {
        out.json = join(REPO_ROOT, "results", "parity.json");
      }
    } else {
      throw new Error(`unknown argument ${String(a)}`);
    }
  }
  return out;
}

function line(s: string): void {
  process.stdout.write(s + "\n");
}

async function main(): Promise<number> {
  let cli: CliArgs;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`parity: ${message(e)}\nusage: parity/harness.ts [--set trap|seeded|all] [--json [out]]\n`);
    return 2;
  }
  const cases: ParityCase[] = [];
  const notes: string[] = [];
  if (cli.set !== "seeded") cases.push(...loadCaseFile(CASE_FILES.trap));
  if (cli.set !== "trap") {
    if (existsSync(CASE_FILES.seeded)) {
      cases.push(...loadCaseFile(CASE_FILES.seeded));
    } else if (cli.set === "seeded") {
      process.stderr.write("parity: parity/cases.seeded.jsonl does not exist (seeded.manifest.json: pending generation)\n");
      return 1;
    } else {
      notes.push("seeded set: pending generation (parity/cases.seeded.jsonl absent) — not run");
    }
  }
  // Existence is judged against every case file on disk; staleness only for the cases this run executes.
  const tolerances = loadTolerances(caseIdsOnDisk());
  const report = await runCases(cases, { bridgeFactory: defaultBridgeFactory, tolerances });

  for (const r of report.results) {
    line(`${r.pass ? "PASS" : "FAIL"} ${r.id} ${r.tool} [${r.view}] ${r.outcome}${r.infra ? ` (${r.infra.stage}: ${r.infra.message})` : ""}${r.bridgeError ? ` (bridge ${r.bridgeError.code})` : ""}`);
    for (const d of r.diffs) {
      line(`    ${d.field}: bridge=${d.bridge} oracle=${d.oracle}${d.pointer ? ` @ ${d.pointer}` : ""} — ${d.message}`);
    }
  }
  for (const p of report.toleranceProblems) line(`TOLERANCE ${p}`);
  for (const n of notes) line(`NOTE ${n}`);
  line(`parity: ${report.passed}/${report.results.length} cases passed; ${report.toleranceProblems.length} tolerance problem(s)`);

  if (cli.json !== null) {
    const out = resolve(cli.json);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ set: cli.set, notes, ...report }, null, 2) + "\n");
    line(`parity: wrote ${out}`);
  }
  return report.pass ? 0 : 1;
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      const kind = e instanceof ReportParseError ? "parse" : "error";
      process.stderr.write(`parity: ${kind}: ${message(e)}\n`);
      process.exitCode = 1;
    },
  );
}
