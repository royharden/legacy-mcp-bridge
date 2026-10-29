// Offline/keyless activation journey. Real SDK stdio + independent oracle + parity/mutants + labelled scripted A policies.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, mkdtempSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runDemoJourneys } from "../eval/run.ts";
import { createBridge } from "../src/bridge/createBridge.ts";
import { loadCaseFile } from "../parity/caseSchema.ts";
import { runCases, type RunOptions } from "../parity/harness.ts";
import { defaultMutationBridgeFactory, runMutants } from "../parity/mutate.ts";
import { loadOracleConfig, runOracle } from "../parity/oracleRunner.ts";
import { loadPrintspec } from "../parity/reportParser.ts";
import { loadTolerances } from "../parity/tolerances.ts";
import { withFixtureProof, type FixtureProof } from "./readonly-proof.ts";

export type DemoStepResult = { name: string; claim: string; passed: boolean; detail: string };
export type DemoStep = { name: string; claim: string; run(): Promise<{ passed: boolean; detail: string }> };
export type DemoReport = { steps: DemoStepResult[]; proof: FixtureProof };
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const TOOLS = ["describe_layouts", "account_get", "accounts_find", "transactions_list", "aging_summary"];

/** Testable sequencing only: fake callbacks test fail-fast orchestration, never stand in for MCP/oracle evidence. */
export async function runDemoSteps(steps: readonly DemoStep[], emit: (message: string) => void = () => {}): Promise<DemoStepResult[]> {
  if (steps.length === 0 || new Set(steps.map((s) => s.name)).size !== steps.length) throw new Error("demo steps must be nonempty and uniquely named");
  const results: DemoStepResult[] = [];
  for (const step of steps) {
    const value = await step.run();
    const result = { name: step.name, claim: step.claim, ...value };
    results.push(result);
    emit(`${result.passed ? "PASS" : "FAIL"} ${step.name}: ${result.detail}`);
    if (!result.passed) throw new Error(`demo step failed: ${step.name}; ${result.detail}`);
  }
  return results;
}

async function stdioTrap(root: string, emit: (message: string) => void): Promise<{ passed: boolean; detail: string }> {
  const entry = join(root, "dist", "server", "stdio.js");
  if (!existsSync(entry)) throw new Error("demo requires npm run build before activation; dist/server/stdio.js is missing");
  const cwd = mkdtempSync(join(tmpdir(), "lmb-demo-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], cwd, stderr: "pipe" });
  const client = new Client({ name: "lmb-offline-demo", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify([...TOOLS].sort())) throw new Error("stdio did not list exactly the five tools");
    const result = await client.callTool({ name: "account_get", arguments: { account_id: "0000000042" } });
    if (result.isError) throw new Error("negative-balance stdio lookup failed");
    const structured = result.structuredContent as { data?: { account_id?: unknown; source?: unknown; balance_minor?: unknown; tax_id?: unknown; monthly_interest_minor?: unknown } };
    const account = structured?.data;
    if (account?.account_id !== "0000000042" || account.source !== "ACCTMSTR#3" || account.balance_minor !== -123456 || account.tax_id !== "***-**-1234" || account.monthly_interest_minor !== -360) throw new Error("stdio trap differs from declared literals");
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content.find((c) => c.type === "text")?.text;
    if (text === undefined || JSON.stringify(JSON.parse(text)) !== JSON.stringify(structured)) throw new Error("stdio text/structured mismatch");
    emit(`Typed stdio result: ${JSON.stringify(structured)}`);
    let refused = false;
    try {
      const write = await client.callTool({ name: "account_post", arguments: { account_id: "0000000042" } });
      refused = write.isError === true && /unknown_tool|unknown tool|tool[^\n]*not found/i.test(JSON.stringify(write.content));
    } catch (error) {
      if (!(error instanceof McpError) || (error.code !== ErrorCode.InvalidParams && error.code !== ErrorCode.MethodNotFound) || !error.message.includes("account_post") || !/unknown|not found|not registered/i.test(error.message)) throw error;
      refused = true;
    }
    if (!refused) throw new Error("account_post was not explicitly refused");
    await client.listTools(); // transport failure is never a passing refusal
    return { passed: true, detail: "real stdio from unrelated cwd; negative trap masked with source; unknown write explicitly refused" };
  } finally {
    try { await client.close(); }
    finally {
      try { await transport.close(); }
      finally { rmdirSync(cwd); } // nonrecursive removal of this invocation's own empty temporary directory only
    }
  }
}

export async function runDemo(options: { repoRoot?: string; emit?: (message: string) => void } = {}): Promise<DemoReport> {
  const root = options.repoRoot ?? REPO_ROOT;
  const emit = options.emit ?? ((message: string): void => { process.stdout.write(message + "\n"); });
  // The proof wraps the entire journey and compares BOTH views even if the first step throws.
  const result = await withFixtureProof(async () => {
    const trapPath = join(root, "parity", "cases.trap.jsonl");
    const seededPath = join(root, "parity", "cases.seeded.jsonl");
    const trap = loadCaseFile(trapPath);
    const seeded = existsSync(seededPath) ? loadCaseFile(seededPath) : [];
    const all = [...trap, ...seeded];
    const negative = trap.find((c) => c.id === "T01");
    if (negative === undefined || trap.length === 0) throw new Error("demo requires the literal T01 trap and nonempty trap suite");
    const config = loadOracleConfig(join(root, "oracle.config.json"));
    const parityOptions: Omit<RunOptions, "bridgeFactory"> = {
      oracle: (report, argv, view) => runOracle(report, argv, { view, config, repoRoot: root }),
      printspec: loadPrintspec(join(root, "parity", "printspec.json")),
      tolerances: loadTolerances(new Set(all.map((c) => c.id)), join(root, "parity", "tolerances.json")),
    };
    const bridgeFactory: RunOptions["bridgeFactory"] = (opts) => createBridge({
      dataRoot: join(root, "fixtures", opts.view === "clean" ? "legacy-clean" : "legacy"), fixturesDir: join(root, "fixtures"), auditPath: null,
      ...(opts.capBytes === undefined ? {} : { capBytes: opts.capBytes }),
    });
    const steps: DemoStep[] = [
      { name: "stdio", claim: "real built stdio protocol and typed negative trap", run: () => stdioTrap(root, emit) },
      { name: "inquiry_projection", claim: "account_inquiry parity under the two declared tolerance kinds", run: async () => {
        const printed = await runOracle("INQUIRY", ["0000000042"], { view: "attacked", config, repoRoot: root });
        // The legacy program intentionally prints an unmasked synthetic tax id. This is the independent report, not a diff.
        emit("Independent legacy INQUIRY (synthetic raw tax id; bridge output above is masked):\n" + printed.stdout);
        const parity = await runCases([negative], { ...parityOptions, bridgeFactory });
        const row = parity.results[0];
        emit(`Projection verdict: ${JSON.stringify({
          matched: row?.matched, declared_ignored: row?.ignored, declared_divergence: row?.divergences,
          unexplained_diffs: row?.diffs, tolerance_problems: parity.toleranceProblems,
        })}`);
        return { passed: parity.pass, detail: "independent printed INQUIRY compared to account_inquiry; any process, parse or unexplained diff fails" };
      } },
      { name: "trap_parity", claim: "every literal trap/contract and named projection", run: async () => {
        const parity = await runCases(trap, { ...parityOptions, bridgeFactory });
        for (const row of parity.results) emit(`${row.pass ? "PASS" : "FAIL"} ${row.id}: ${row.outcome}`);
        return { passed: parity.pass, detail: `${parity.passed}/${parity.results.length} trap cases; tolerance problems ${parity.toleranceProblems.length}` };
      } },
      { name: "mutations", claim: "full/smoke/schema-only author-chosen mutant experiment", run: async () => {
        const report = await runMutants({ cases: all, parityOptions, bridgeFactory: (opts) => root === REPO_ROOT ? defaultMutationBridgeFactory(opts) : createBridge({
          dataRoot: join(root, "fixtures", opts.view === "clean" ? "legacy-clean" : "legacy"), fixturesDir: join(root, "fixtures"), auditPath: null,
          ...(opts.capBytes === undefined ? {} : { capBytes: opts.capBytes }), ...(opts.ops === undefined ? {} : { ops: opts.ops }),
        }) });
        emit(`Mutation scope: ${report.case_count} cases; ${seeded.length === 0 ? "seeded pending/absent; full means trap-only, not trap+seeded" : "trap plus present seeded set"}`);
        for (const note of report.notes) emit(`NOTE ${note}`);
        for (const mutant of report.mutants) emit(`${mutant.name}: ${report.selected_suites.map((suite) => `${suite}=${mutant.suites[suite].outcome} cases[${mutant.suites[suite].case_ids.join(",")}]`).join("; ")}`);
        return { passed: report.pass, detail: `full=${JSON.stringify(report.counts.full)}; smoke=${JSON.stringify(report.counts.smoke)}; schema-only=${JSON.stringify(report.counts["schema-only"])}` };
      } },
      { name: "scripted_journeys", claim: "SCRIPTED FIXTURE policy replay, never model accuracy", run: async () => {
        const demo = await runDemoJourneys({ repoRoot: root });
        emit(`${demo.run.label}; ${demo.run.live_metrics}; ${JSON.stringify(demo.journeys)}`);
        for (const row of demo.run.conditions) for (const outcome of row.outcomes) emit(`${outcome.question_id}: ${outcome.passed ? "scripted policy passed" : outcome.reason}; status=${outcome.answer?.status ?? "missing"}; forbidden calls=${outcome.forbidden_tool_attempts}`);
        return { passed: demo.passed, detail: "filtered debit total; typed refusal with zero tool attempts; injection and clean twin factual equality/no forbidden calls" };
      } },
    ];
    return runDemoSteps(steps, emit);
  }, { repoRoot: root });
  emit(`Fixture proof: ${Object.keys(result.proof.before).length} files/names unchanged across both views.`);
  return { steps: result.value, proof: result.proof };
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  if (process.argv.length > 2) { process.stderr.write("demo takes no options; it is offline/keyless and never enables live evaluation\n"); process.exitCode = 2; }
  else runDemo().catch((error: unknown) => {
    process.stderr.write(`demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof AggregateError) for (const cause of error.errors) process.stderr.write(`  ${String(cause)}\n`);
    process.exitCode = 1;
  });
}
