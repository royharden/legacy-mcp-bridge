// tests/parity/oracleRunner.test.ts — oracle runner self-tests with an injected fake execFile (no process is ever spawned):
// POST refused structurally, timeout and output cap enforced and passed to execFile, argv validated, no shell, the run
// timestamp pinned, every failure typed.
import { describe, expect, it } from "vitest";
import { CaseSchema } from "../../parity/caseSchema.ts";
import {
  FIXED_RUN_TS,
  OracleError,
  runOracle,
  validateOracleConfig,
  type ExecFileErrorLike,
  type ExecFileLike,
  type ExecFileOptionsLike,
  type OracleConfig,
} from "../../parity/oracleRunner.ts";

const CONFIG: OracleConfig = validateOracleConfig({
  command: "node",
  entry: "legacy/legacy.mjs",
  reports: ["INQUIRY", "LIST", "HISTORY", "AGING", "LAYOUT"],
  views: ["attacked", "clean"],
  timeoutMs: 1234,
  maxOutputBytes: 1000,
});

type Call = { file: string; args: readonly string[]; options: ExecFileOptionsLike };

function fakeExec(reply: (call: Call) => { error: ExecFileErrorLike | null; stdout?: string; stderr?: string }): {
  exec: ExecFileLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const exec: ExecFileLike = (file, args, options, callback) => {
    const call = { file, args, options };
    calls.push(call);
    const r = reply(call);
    callback(r.error, r.stdout ?? "", r.stderr ?? "");
    return undefined;
  };
  return { exec, calls };
}

function execError(props: Partial<ExecFileErrorLike>): ExecFileErrorLike {
  return Object.assign(new Error("child failed"), props);
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (e) {
    expect(e).toBeInstanceOf(OracleError);
    return (e as OracleError).kind;
  }
}

describe("parity oracle runner", () => {
  it("POST refused structurally: no process spawned", async () => {
    const { exec, calls } = fakeExec(() => ({ error: null, stdout: "" }));
    expect(await kindOf(runOracle("POST", ["0000000001", "D", "1.00"], { view: "attacked", config: CONFIG, execFile: exec }))).toBe("refused");
    expect(calls).toHaveLength(0);
  });

  it("POST cannot be allowlisted in oracle.config.json or named by a case", () => {
    expect(() => validateOracleConfig({ ...CONFIG, reports: [...CONFIG.reports, "POST"] })).toThrow(OracleError);
    const r = CaseSchema.safeParse({
      id: "T01",
      kind: "parity",
      tool: "account_get",
      args: { account_id: "0000000001" },
      oracle: { report: "POST", argv: ["0000000001", "D", "1.00"] },
      projection: "account_inquiry",
      expect: {},
      tags: ["trap:write_refused"],
      what_bug_this_catches: "a write command reaching the oracle",
    });
    expect(r.success).toBe(false);
  });

  it("oracle timeout enforced: configured timeout passed to execFile and a killed child is a typed timeout", async () => {
    const { exec, calls } = fakeExec(() => ({ error: execError({ killed: true, signal: "SIGTERM", code: null }) }));
    expect(await kindOf(runOracle("LAYOUT", [], { view: "attacked", config: CONFIG, execFile: exec }))).toBe("timeout");
    expect(calls[0]?.options.timeout).toBe(1234);
  });

  it("oracle output cap enforced: maxBuffer passed, overflow and oversized stdout are typed failures", async () => {
    const overflow = fakeExec(() => ({ error: execError({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }) }));
    expect(await kindOf(runOracle("LAYOUT", [], { view: "attacked", config: CONFIG, execFile: overflow.exec }))).toBe("output_cap");
    expect(overflow.calls[0]?.options.maxBuffer).toBe(1000);
    const big = fakeExec(() => ({ error: null, stdout: "x".repeat(1001) }));
    expect(await kindOf(runOracle("LAYOUT", [], { view: "attacked", config: CONFIG, execFile: big.exec }))).toBe("output_cap");
  });

  it("runs node without a shell, --view before the command, pinned LEGACY_RUN_TS, minimal env", async () => {
    const { exec, calls } = fakeExec(() => ({ error: null, stdout: "REPORT\n" }));
    const out = await runOracle("HISTORY", ["0000000052", "2000-01-01", "2049-12-31"], { view: "clean", config: CONFIG, execFile: exec });
    expect(out.stdout).toBe("REPORT\n");
    const call = calls[0];
    expect(call?.file).toBe(process.execPath);
    expect(call?.args.slice(1)).toEqual(["--view", "clean", "HISTORY", "0000000052", "2000-01-01", "2049-12-31"]);
    expect(call?.args[0]?.replace(/\\/g, "/")).toMatch(/legacy\/legacy\.mjs$/);
    expect(call?.options.shell).toBe(false);
    expect(call?.options.env.LEGACY_RUN_TS).toBe(FIXED_RUN_TS);
    expect(Object.keys(call?.options.env ?? {}).some((k) => /KEY|TOKEN|SECRET/i.test(k))).toBe(false);
  });

  it("argv is validated before spawning (leading dash, wrong shape, unknown report, unknown view)", async () => {
    const { exec, calls } = fakeExec(() => ({ error: null, stdout: "" }));
    const o = { view: "attacked" as const, config: CONFIG, execFile: exec };
    expect(await kindOf(runOracle("INQUIRY", ["--help"], o))).toBe("bad_argv");
    expect(await kindOf(runOracle("INQUIRY", ["42"], o))).toBe("bad_argv");
    expect(await kindOf(runOracle("LIST", ["STATUS", "X"], o))).toBe("bad_argv");
    expect(await kindOf(runOracle("LIST", ["STATUS", "A", "PREFIX", "-rf"], o))).toBe("bad_argv");
    expect(await kindOf(runOracle("HISTORY", ["0000000052", "2024-02-30", "2024-03-01"], o))).toBe("bad_argv");
    expect(await kindOf(runOracle("AGING", ["2024-03-01", "extra"], o))).toBe("bad_argv");
    expect(await kindOf(runOracle("DELETE", [], o))).toBe("bad_report");
    expect(await kindOf(runOracle("LAYOUT", [], { ...o, view: "other" as "clean" }))).toBe("bad_view");
    expect(calls).toHaveLength(0);
  });

  it("a nonzero exit is a typed failure carrying the exit code", async () => {
    const { exec } = fakeExec(() => ({ error: execError({ code: 3 }), stderr: "LEGACY01: DATA FILE MISSING\n" }));
    try {
      await runOracle("LAYOUT", [], { view: "attacked", config: CONFIG, execFile: exec });
      expect.unreachable();
    } catch (e) {
      expect((e as OracleError).kind).toBe("nonzero_exit");
      expect((e as OracleError).exitCode).toBe(3);
    }
  });
});
