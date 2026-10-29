// Hash all names and contents in both fixture views around fixed, shell-free validation steps, even when a child fails.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PROOF_REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
export type FixtureSnapshot = Record<string, { bytes: number; sha256: string }>;
export type FixtureProof = { before: FixtureSnapshot; after: FixtureSnapshot; unchanged: true };
export type ProofStep = "parity" | "mutants" | "eval:mock";
export type ProofStepResult = { step: ProofStep; stdout: string; stderr: string };

/** Missing views/required files and symlinks fail closed. Additional files, including nested ones, are hashed too. */
export function hashFixtureViews(repoRoot: string = PROOF_REPO_ROOT): FixtureSnapshot {
  const snapshot: FixtureSnapshot = {};
  for (const view of ["legacy", "legacy-clean"] as const) {
    const root = join(repoRoot, "fixtures", view);
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error(`fixture view is not a plain directory: ${view}`);
    const visit = (dir: string, prefix: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        const key = `${prefix}/${name}`;
        const info = lstatSync(path);
        if (info.isSymbolicLink()) throw new Error(`fixture symlink refused: ${key}`);
        if (info.isDirectory()) visit(path, key);
        else if (info.isFile()) {
          const bytes = readFileSync(path);
          snapshot[key] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        } else throw new Error(`fixture special file refused: ${key}`);
      }
    };
    visit(root, view);
    for (const file of ["ACCTMSTR.DAT", "TRANS.DAT"]) {
      if (snapshot[`${view}/${file}`] === undefined) throw new Error(`missing required fixture: ${view}/${file}; generate and freeze fixtures before validation`);
    }
  }
  return snapshot;
}

export function fixtureChanges(before: FixtureSnapshot, after: FixtureSnapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter((key) =>
    before[key]?.bytes !== after[key]?.bytes || before[key]?.sha256 !== after[key]?.sha256);
}

/** Always checks after the action. If work and integrity both fail, retain both errors instead of hiding either. */
export async function withFixtureProof<T>(action: () => T | Promise<T>, options: { repoRoot?: string } = {}): Promise<{ value: T; proof: FixtureProof }> {
  const root = options.repoRoot ?? PROOF_REPO_ROOT;
  const before = hashFixtureViews(root);
  let after = before;
  let result: { ok: true; value: T } | { ok: false; error: unknown } = { ok: false, error: new Error("action did not complete") };
  try {
    result = { ok: true, value: await action() };
  } catch (error) {
    result = { ok: false, error };
  } finally {
    try {
      after = hashFixtureViews(root);
      const changed = fixtureChanges(before, after);
      if (changed.length > 0) throw new Error(`read-only proof failed; fixture names or contents changed: ${changed.join(", ")}`);
    } catch (proofError) {
      if (!result.ok) throw new AggregateError([result.error, proofError], "validation work failed and fixture integrity failed");
      throw proofError;
    }
  }
  if (!result.ok) throw result.error;
  return { value: result.value, proof: { before, after, unchanged: true } };
}

const STEP_ARGS: Readonly<Record<ProofStep, readonly string[]>> = {
  parity: ["parity/harness.ts"],
  mutants: ["parity/mutate.ts"],
  "eval:mock": ["eval/run.ts", "--mode", "mock"],
};

function runStep(step: ProofStep, repoRoot: string): Promise<ProofStepResult> {
  const fixed = STEP_ARGS[step];
  if (fixed === undefined) return Promise.reject(new Error(`unknown read-only proof step: ${String(step)}`));
  const entry = fixed[0];
  if (entry === undefined) return Promise.reject(new Error("missing fixed step entry"));
  const args = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(repoRoot, entry), ...fixed.slice(1)];
  return new Promise((accept, reject) => {
    execFile(process.execPath, args, {
      cwd: repoRoot, shell: false, windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${step} failed: ${error.message}; ${stderr.slice(0, 300)}`, { cause: error }));
      } else accept({ step, stdout, stderr });
    });
  });
}

/** Hash both views around parity, mutants and the scripted evaluation; M6 reuses this wrapper for its full journey. */
export async function runReadOnlyProof(options: { repoRoot?: string; steps?: readonly ProofStep[] } = {}): Promise<{
  value: ProofStepResult[]; proof: FixtureProof;
}> {
  const repoRoot = options.repoRoot ?? PROOF_REPO_ROOT;
  const steps = options.steps ?? ["parity", "mutants", "eval:mock"];
  if (steps.length === 0 || steps.some((step) => !Object.prototype.hasOwnProperty.call(STEP_ARGS, step))) throw new Error("select known read-only proof steps");
  return withFixtureProof(async () => {
    const results: ProofStepResult[] = [];
    for (const step of steps) results.push(await runStep(step, repoRoot));
    return results;
  }, { repoRoot });
}

const invoked = process.argv[1];
if (invoked !== undefined && pathToFileURL(resolve(invoked)).href === import.meta.url) {
  runReadOnlyProof().then(({ value, proof }) => {
    for (const result of value) {
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
    }
    process.stdout.write(`read-only proof: ${Object.keys(proof.before).length} fixture files unchanged across both views\n`);
  }).catch((error: unknown) => {
    process.stderr.write(`read-only proof: ${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof AggregateError) for (const cause of error.errors) process.stderr.write(`  ${String(cause)}\n`);
    process.exitCode = 1;
  });
}
