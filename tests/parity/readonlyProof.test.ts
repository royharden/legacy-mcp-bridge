// Read-only proof controls use temporary literal files, never the canonical fixture views or child validation programs.
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixtureChanges, hashFixtureViews, withFixtureProof } from "../../scripts/readonly-proof.ts";

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lmb-proof-"));
  for (const view of ["legacy", "legacy-clean"]) {
    const dir = join(root, "fixtures", view);
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "ACCTMSTR.DAT"), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, "TRANS.DAT"), Buffer.from([3, 4, 5]));
    writeFileSync(join(dir, "nested", "extra.bin"), Buffer.from([255]));
  }
  return root;
}

describe("read-only fixture proof", () => {
  it("hashes every file in both views and returns the action result when all names/contents match", async () => {
    const root = fixtureRoot();
    const result = await withFixtureProof(() => "completed", { repoRoot: root });
    expect(result.value).toBe("completed");
    expect(result.proof.unchanged).toBe(true);
    expect(Object.keys(result.proof.before)).toHaveLength(6);
    expect(fixtureChanges(result.proof.before, result.proof.after)).toEqual([]);
    expect(result.proof.before["legacy/nested/extra.bin"]?.bytes).toBe(1);
  });

  it("detects content changes, same-byte renames and added files", async () => {
    for (const operation of ["content", "rename", "addition"]) {
      const root = fixtureRoot();
      const dir = join(root, "fixtures", "legacy-clean", "nested");
      await expect(withFixtureProof(() => {
        if (operation === "content") writeFileSync(join(dir, "extra.bin"), Buffer.from([0]));
        else if (operation === "rename") renameSync(join(dir, "extra.bin"), join(dir, "renamed.bin"));
        else writeFileSync(join(dir, "added.bin"), "added");
      }, { repoRoot: root })).rejects.toThrow(/fixture names or contents changed/);
    }
  });

  it("checks in finally after action failure and preserves both work/integrity errors", async () => {
    const unchanged = fixtureRoot();
    const workError = new Error("child failed");
    await expect(withFixtureProof(() => { throw workError; }, { repoRoot: unchanged })).rejects.toBe(workError);
    const changed = fixtureRoot();
    try {
      await withFixtureProof(() => {
        writeFileSync(join(changed, "fixtures", "legacy", "TRANS.DAT"), "changed");
        throw workError;
      }, { repoRoot: changed });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors[0]).toBe(workError);
      expect(String((error as AggregateError).errors[1])).toContain("legacy/TRANS.DAT");
    }
  });

  it("missing fixture views fail before invoking the action", async () => {
    const root = mkdtempSync(join(tmpdir(), "lmb-proof-missing-"));
    let called = false;
    expect(() => hashFixtureViews(root)).toThrow();
    await expect(withFixtureProof(() => { called = true; }, { repoRoot: root })).rejects.toThrow();
    expect(called).toBe(false);
  });
});
