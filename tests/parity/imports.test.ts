// tests/parity/imports.test.ts — independence of the parity harness: parity/*.ts reaches into src/ only through
// src/bridge/createBridge.ts (the public factory). Pagination, cursor, cap, mask and decoder helpers are never reused, so the
// page-union check and the tax-id mask are harness code (PLAN M3 (f)).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ALLOWED_SRC = new Set(["../src/bridge/createBridge.ts"]);

function specifiers(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? "");
  return out;
}

describe("parity harness independence", () => {
  it("parity/*.ts imports from src/ only src/bridge/createBridge.ts", () => {
    const files = readdirSync(join(REPO, "parity")).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of files) {
      for (const s of specifiers(readFileSync(join(REPO, "parity", f), "utf8"))) {
        if (s.includes("src/") && !ALLOWED_SRC.has(s) && f !== "mutate.ts") offenders.push(`${f}: ${s}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
