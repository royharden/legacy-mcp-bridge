// parity/oracleRunner.ts — runs the stand-in legacy program as a child process for one report. The program, report
// allowlist, views, timeout and output cap come only from oracle.config.json; argv is validated against the strict
// per-report grammar; POST is refused before anything is spawned. Every failure is a typed OracleError (never a pass).
import { execFile as nodeExecFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { argvProblem } from "./caseSchema.ts";

export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The only volatile oracle field, pinned so reports are byte-deterministic (PRINTSPEC: LEGACY_RUN_TS). */
export const FIXED_RUN_TS = "2000-01-01 00:00:00";

export type OracleView = "attacked" | "clean";

export type OracleConfig = {
  command: "node";
  entry: string;
  reports: string[];
  views: OracleView[];
  timeoutMs: number;
  maxOutputBytes: number;
};

export type ExecFileOptionsLike = {
  cwd: string;
  env: Record<string, string>;
  shell: false;
  timeout: number;
  maxBuffer: number;
  encoding: "latin1";
  windowsHide: true;
};

export type ExecFileErrorLike = Error & {
  code?: string | number | null;
  killed?: boolean;
  signal?: string | null;
};

/** The subset of child_process.execFile the runner uses; tests inject a fake (no process is spawned). */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsLike,
  callback: (error: ExecFileErrorLike | null, stdout: string, stderr: string) => void,
) => unknown;

export const ORACLE_ERROR_KINDS = [
  "refused",
  "bad_config",
  "bad_report",
  "bad_view",
  "bad_argv",
  "timeout",
  "output_cap",
  "nonzero_exit",
  "spawn_failed",
] as const;
export type OracleErrorKind = (typeof ORACLE_ERROR_KINDS)[number];

export class OracleError extends Error {
  readonly kind: OracleErrorKind;
  readonly exitCode: number | null;
  constructor(kind: OracleErrorKind, message: string, exitCode: number | null = null) {
    super(`oracle ${kind}: ${message}`);
    this.name = "OracleError";
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

/** Reads and validates oracle.config.json. The write command can never be allowlisted. */
export function loadOracleConfig(path: string = join(REPO_ROOT, "oracle.config.json")): OracleConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new OracleError("bad_config", `cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validateOracleConfig(raw);
}

export function validateOracleConfig(raw: unknown): OracleConfig {
  const bad = (m: string): never => {
    throw new OracleError("bad_config", m);
  };
  if (typeof raw !== "object" || raw === null) return bad("config is not an object");
  const c = raw as Record<string, unknown>;
  if (c.command !== "node") bad("command must be node");
  if (typeof c.entry !== "string" || isAbsolute(c.entry) || c.entry.includes("..")) bad("entry must be a relative path");
  const reports = c.reports;
  if (!Array.isArray(reports) || reports.length === 0 || !reports.every((r) => typeof r === "string")) {
    bad("reports must be a non-empty string array");
  }
  if ((reports as string[]).includes("POST")) bad("POST must never be allowlisted");
  const views = c.views;
  if (!Array.isArray(views) || !views.every((v) => v === "attacked" || v === "clean")) bad("views must be attacked/clean");
  const positive = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (!positive(c.timeoutMs)) bad("timeoutMs must be a positive integer");
  if (!positive(c.maxOutputBytes)) bad("maxOutputBytes must be a positive integer");
  return {
    command: "node",
    entry: c.entry as string,
    reports: reports as string[],
    views: views as OracleView[],
    timeoutMs: c.timeoutMs as number,
    maxOutputBytes: c.maxOutputBytes as number,
  };
}

export type RunOracleOptions = {
  view: OracleView;
  config?: OracleConfig;
  execFile?: ExecFileLike;
  repoRoot?: string;
};

/** Child environment: only what Node needs plus the pinned run timestamp (no inherited secrets). */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = { LEGACY_RUN_TS: FIXED_RUN_TS };
  for (const k of ["SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/**
 * Runs `node <entry> --view <view> <report> ...argv` (execFile, no shell) and resolves with stdout. POST and anything off
 * the allowlist are refused before spawning.
 */
export function runOracle(report: string, argv: readonly string[], opts: RunOracleOptions): Promise<{ stdout: string }> {
  // Structural refusal first: nothing below can turn a write command into a spawn.
  if (report === "POST") return Promise.reject(new OracleError("refused", "POST is a write command; the harness never runs it"));
  let config: OracleConfig;
  try {
    config = opts.config ?? loadOracleConfig();
  } catch (e) {
    return Promise.reject(e);
  }
  if (!config.reports.includes(report)) return Promise.reject(new OracleError("bad_report", `${report} is not allowlisted`));
  if (!config.views.includes(opts.view)) return Promise.reject(new OracleError("bad_view", `${opts.view} is not a configured view`));
  const problem = argvProblem(report, argv);
  if (problem !== null) return Promise.reject(new OracleError("bad_argv", problem));

  const root = opts.repoRoot ?? REPO_ROOT;
  const entry = resolve(root, config.entry);
  const rel = relative(root, entry);
  if (rel.startsWith("..") || isAbsolute(rel)) return Promise.reject(new OracleError("bad_config", "entry escapes the repository"));

  const exec: ExecFileLike = opts.execFile ?? (nodeExecFile as unknown as ExecFileLike);
  const args = [entry, "--view", opts.view, report, ...argv];
  const options: ExecFileOptionsLike = {
    cwd: root,
    env: childEnv(),
    shell: false,
    timeout: config.timeoutMs,
    maxBuffer: config.maxOutputBytes,
    encoding: "latin1",
    windowsHide: true,
  };
  return new Promise((resolvePromise, rejectPromise) => {
    try {
      exec(process.execPath, args, options, (error, stdout, stderr) => {
        if (error !== null) {
          rejectPromise(classify(error, stderr, config));
          return;
        }
        if (Buffer.byteLength(stdout, "latin1") > config.maxOutputBytes) {
          rejectPromise(new OracleError("output_cap", `stdout exceeds ${config.maxOutputBytes} bytes`));
          return;
        }
        resolvePromise({ stdout });
      });
    } catch (e) {
      rejectPromise(new OracleError("spawn_failed", e instanceof Error ? e.message : String(e)));
    }
  });
}

function classify(error: ExecFileErrorLike, stderr: string, config: OracleConfig): OracleError {
  const firstLine = (stderr.split("\n")[0] ?? "").slice(0, 200);
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new OracleError("output_cap", `output exceeded maxBuffer ${config.maxOutputBytes} bytes`);
  }
  if (error.killed === true || error.signal === "SIGTERM") {
    return new OracleError("timeout", `killed after ${config.timeoutMs} ms`);
  }
  if (typeof error.code === "number") {
    return new OracleError("nonzero_exit", `exit ${error.code}: ${firstLine}`, error.code);
  }
  return new OracleError("spawn_failed", `${error.message} ${firstLine}`.trim());
}
