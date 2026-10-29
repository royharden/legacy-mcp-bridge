// tests/static/no-console.test.ts — stdout is MCP protocol only: no file under src/ may use the console object
// (diagnostics go through process.stderr). Complements eslint no-console in src/.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(REPO, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(e.name) ? [p] : [];
  });
}

describe("no console in src/", () => {
  it("scans a non-empty source tree", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(0);
  });

  it("no file under src/ references console.*", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/\bconsole\s*(?:\.|\[)/.test(line)) offenders.push(`${relative(REPO, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
