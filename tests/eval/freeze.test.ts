// Freeze-2 byte-pinning controls use independent temp literals; no real heldout file, seeded generator, provider or oracle is opened.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyFreeze2 } from "../../eval/run.ts";

const seededFiles = ["../parity/seeded.manifest.json", "../parity/cases.seeded.jsonl"] as const;
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
type FixtureOptions = { omitFiles?: readonly string[]; unpinned?: string; changed?: string; pending?: boolean; wrongSeedHash?: boolean };

function frozenFixture(options: FixtureOptions = {}): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "lmb-freeze2-"));
  const root = join(repoRoot, "eval");
  // The freeze gate validates bytes and metadata; parity's own suite owns the seeded case schema/count.
  const cases = '{"id":"S001","literal":"independent frozen byte fixture"}\n';
  const files = new Map<string, string>([
    ["questions.dev.jsonl", '{"literal":"dev"}\n'],
    ["questions.heldout.jsonl", '{"literal":"heldout"}\n'],
    ["conditions/d.ts", "// literal frozen router\n"],
    ["policy.ts", "// literal frozen policy\n"],
    ["prices.json", '{"literal":"prices"}\n'],
    ["resource-policy.json", JSON.stringify({ version: 1, status: "frozen", wholeExperimentBudgetUsd: 5,
      limits: { A: { toolCalls: 8, rawBytes: 1048576 }, C2: { toolCalls: 64, rawBytes: 1048576 }, C: { toolCalls: 64, rawBytes: 1048576 } },
      shared: { maxOutputTokens: 1024, outputTokens: 12288, inputTokens: 40000, seconds: 900, retries: 2 },
      constrained: { C2: ["aging"], C: ["aging"] }, freeze: { status: "frozen", frozenAt: "2026-10-24" } }) + "\n"],
    ["../parity/cases.seeded.jsonl", cases],
    ["../parity/seeded.manifest.json", JSON.stringify({ status: options.pending ? "pending generation" : "generated",
      output: "parity/cases.seeded.jsonl", freeze_date: "2026-10-24", sha256: sha256(options.wrongSeedHash ? "OTHER LITERAL BYTES\n" : cases) }) + "\n"],
  ]);
  for (let id = 1; id <= 30; id++) files.set(`policies/DEV${String(id).padStart(2, "0")}.json`, '{"literal":"policy"}\n');
  const frozenFiles: Record<string, string> = {};
  for (const [name, text] of files) {
    if (options.unpinned !== name) frozenFiles[name] = sha256(text);
    if (options.omitFiles?.includes(name)) continue;
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text + (options.changed === name ? "\n" : ""), "utf8");
  }
  writeFileSync(join(root, "split.manifest.json"), JSON.stringify({ version: 1, status: "frozen", frozenAt: "2026-10-24", frozenFiles }) + "\n", "utf8");
  return repoRoot;
}

describe("freeze 2 seeded parity gate", () => {
  it("accepts generated seeded artifacts pinned by the split and output manifests", () => {
    expect(() => verifyFreeze2(frozenFixture())).not.toThrow();
  });
  it.each(seededFiles)("rejects a missing %s before opening heldout", (name) => {
    // what_bug_this_catches: a frozen eval-only manifest used to admit heldout with no generated seeded parity set.
    const root = frozenFixture({ omitFiles: [name, "questions.heldout.jsonl"] });
    expect(() => verifyFreeze2(root)).toThrow(`freeze 2 missing or changed: ${name}`);
  });
  it("rejects a pinned pending-generation manifest before opening heldout", () => {
    const root = frozenFixture({ pending: true, omitFiles: ["questions.heldout.jsonl"] });
    expect(() => verifyFreeze2(root)).toThrow(/generated/);
  });
  it.each(seededFiles)("rejects an unpinned %s", (name) => {
    expect(() => verifyFreeze2(frozenFixture({ unpinned: name }))).toThrow(`freeze 2 missing or changed: ${name}`);
  });
  it.each(seededFiles)("rejects changed bytes in %s before opening heldout", (name) => {
    const root = frozenFixture({ changed: name, omitFiles: ["questions.heldout.jsonl"] });
    expect(() => verifyFreeze2(root)).toThrow(`freeze 2 missing or changed: ${name}`);
  });
  it("requires the generated manifest's output hash to match even when both split pins match", () => {
    expect(() => verifyFreeze2(frozenFixture({ wrongSeedHash: true }))).toThrow("seeded output differs from seeded.manifest.json sha256");
  });
});
