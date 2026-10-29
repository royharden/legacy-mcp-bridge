// tests/static/no-float-money.test.ts — money is integer minor units with BigInt intermediates: the money paths
// (src/fixedwidth, src/bridge, parity/) contain no float parsing or fixed-point formatting. Complements the eslint
// no-restricted-* rules on the same directories.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const MONEY_DIRS = ["src/fixedwidth", "src/bridge", "parity"];
const BANNED: { name: string; re: RegExp }[] = [
  { name: "parseFloat", re: /\bparseFloat\b/ },
  { name: "toFixed(", re: /\.toFixed\s*\(/ },
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(e.name) ? [p] : [];
  });
}

describe("no float money", () => {
  it("scans the decoder at least", () => {
    expect(sourceFiles(join(REPO, "src/fixedwidth")).length).toBeGreaterThan(0);
  });

  it("no parseFloat / toFixed( in src/fixedwidth, src/bridge, parity/", () => {
    const offenders: string[] = [];
    for (const d of MONEY_DIRS) {
      for (const file of sourceFiles(join(REPO, d))) {
        readFileSync(file, "utf8")
          .split(/\r?\n/)
          .forEach((line, i) => {
            for (const b of BANNED) {
              if (b.re.test(line)) offenders.push(`${relative(REPO, file)}:${i + 1}: ${b.name}: ${line.trim()}`);
            }
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
