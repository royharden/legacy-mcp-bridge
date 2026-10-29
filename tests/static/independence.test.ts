// tests/static/independence.test.ts — independence boundaries (PLAN §4) and repo hygiene:
// legacy/**/*.mjs imports only legacy-local modules and node: built-ins and holds no path string naming src/, layouts,
// parity/, eval/ or scripts/ (fixture data paths are allowed); scripts/gen-fixtures.ts never imports the bridge decoder;
// .gitattributes keeps the .DAT fixtures binary; .env.example names no VITE_ variable and carries no secret value.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { specifiers, stringLiterals } from "../helpers/importScan.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const LEGACY = join(REPO, "legacy");

const repoPath = (abs: string): string => relative(REPO, abs).split(sep).join("/");

function mjsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return mjsFiles(p);
    return e.name.endsWith(".mjs") ? [p] : [];
  });
}

const FORBIDDEN_PATH_STRINGS = [/\bsrc\//, /layouts/, /\bparity\//, /\beval\//, /\bscripts\//];

describe("legacy oracle independence", () => {
  const files = mjsFiles(LEGACY);

  it("scans the oracle sources", () => {
    expect(files.map(repoPath)).toContain("legacy/legacy.mjs");
  });

  it("imports only ./ ../ (staying inside legacy/) and node: built-ins", () => {
    const bad: string[] = [];
    for (const file of files) {
      for (const spec of specifiers(readFileSync(file, "utf8"))) {
        if (spec.startsWith("node:")) continue;
        if (spec.startsWith("./") || spec.startsWith("../")) {
          const target = resolve(dirname(file), spec);
          if (!repoPath(target).startsWith("legacy/") || !existsSync(target)) bad.push(`${repoPath(file)} -> ${spec}`);
          continue;
        }
        bad.push(`${repoPath(file)} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("holds no path string naming src/, layouts, parity/, eval/ or scripts/", () => {
    const bad: string[] = [];
    for (const file of files) {
      for (const s of stringLiterals(readFileSync(file, "utf8"))) {
        if (FORBIDDEN_PATH_STRINGS.some((re) => re.test(s))) bad.push(`${repoPath(file)}: "${s}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the string scan finds literals but ignores comments", () => {
    const sample = '// see src/x\nconst a = "../src/fixedwidth"; /* layouts */ const b = `parity/${1}`;';
    expect(stringLiterals(sample)).toEqual(["../src/fixedwidth", "parity/${1}"]);
  });
});

describe("fixture generator independence", () => {
  it("scripts/gen-fixtures.ts never imports the bridge decoder", () => {
    const file = join(REPO, "scripts", "gen-fixtures.ts");
    const hits = specifiers(readFileSync(file, "utf8")).filter((spec) => {
      if (!spec.startsWith(".")) return false;
      return /^src\/fixedwidth\/decode/.test(repoPath(resolve(dirname(file), spec)));
    });
    expect(hits).toEqual([]);
  });
});

describe("repo hygiene", () => {
  it(".gitattributes keeps fixture .DAT files binary", () => {
    const lines = readFileSync(join(REPO, ".gitattributes"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(lines).toContain("fixtures/**/*.DAT binary");
  });

  it(".env.example names no VITE_ variable and leaves every secret empty", () => {
    const entries = readFileSync(join(REPO, ".env.example"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"))
      .map((l) => {
        const eq = l.indexOf("=");
        return { name: eq < 0 ? l : l.slice(0, eq).trim(), value: eq < 0 ? "" : l.slice(eq + 1).trim() };
      });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.filter((e) => e.name.startsWith("VITE_")).map((e) => e.name)).toEqual([]);
    const secrets = entries.filter((e) => /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(e.name));
    expect(secrets.map((e) => e.name)).toContain("ANTHROPIC_API_KEY");
    expect(secrets.filter((e) => e.value !== "").map((e) => e.name)).toEqual([]);
  });
});
