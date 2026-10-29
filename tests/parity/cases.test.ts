// Case-catalogue and seeded-PRNG checks; generator output stays in memory and is never written by these tests.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CaseSchema, loadCaseFile } from "../../parity/caseSchema.ts";
import { genCases } from "../../parity/genSeededCases.ts";
import { CASE_FILES } from "../../parity/harness.ts";
import { MUTANT_NAMES, TOOL_NAMES } from "../../parity/projections.ts";

describe("parity case catalogue", () => {
  it("all trap literals validate, cover all twelve mutant tags and retain exactly five smoke cases", () => {
    const cases = loadCaseFile(CASE_FILES.trap);
    expect(cases).toHaveLength(34);
    expect(cases.filter((c) => c.tags.includes("smoke"))).toHaveLength(5);
    for (const c of cases) {
      expect(c.expect).not.toBeNull();
      expect(c.tags.some((t) => t.startsWith("trap:"))).toBe(true);
      expect(c.what_bug_this_catches.length).toBeGreaterThanOrEqual(10);
    }
    for (const mutant of MUTANT_NAMES) {
      expect(cases.some((c) => c.tags.includes(`mutant:${mutant}`)), mutant).toBe(true);
    }
    expect(cases.some((c) => c.tool === "accounts_find" && typeof c.expect?.balance_total_minor === "number")).toBe(true);
  });

  it("the seeded PRNG is deterministic, seed-sensitive, independent of the fixture seed and stratified 12 per tool", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../parity/seeded.manifest.json", import.meta.url), "utf8")) as {
      seed: number; count: number; fixture_generator_seed: number;
    };
    const plants = JSON.parse(readFileSync(new URL("../../fixtures/plants.json", import.meta.url), "utf8")) as {
      generator: { seed: number };
    };
    expect(manifest.seed).not.toBe(plants.generator.seed);
    expect(manifest.fixture_generator_seed).toBe(plants.generator.seed);
    const generated = genCases(manifest.seed);
    expect(generated).toEqual(genCases(manifest.seed));
    expect(generated).not.toEqual(genCases(manifest.seed + 1));
    expect(generated).toHaveLength(60);
    expect(generated).toHaveLength(manifest.count);
    expect(generated.map((c) => c.id)).toEqual(Array.from({ length: 60 }, (_, i) => `S${String(i + 1).padStart(3, "0")}`));
    for (const c of generated) expect(() => CaseSchema.parse(c)).not.toThrow();
    for (const tool of TOOL_NAMES) expect(generated.filter((c) => c.tool === tool)).toHaveLength(12);
  });
});
