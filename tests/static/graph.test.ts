// tests/static/graph.test.ts — production import graph (PLAN §4): the transitive relative-import graph from
// src/server/stdio.ts reaches only src/{fixedwidth,mcpkit,bridge,server} (never mutants.ts, legacy/, parity/, eval/, lib/,
// scripts/), bare imports are only the MCP SDK, zod and node: built-ins, and no reached file reads process.env or
// process.argv (nothing can select a mutant or a data view in the server).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { specifiers } from "../helpers/importScan.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = join(REPO, "src", "server", "stdio.ts");

const ALLOWED_DIRS = ["src/fixedwidth/", "src/mcpkit/", "src/bridge/", "src/server/"];
const FORBIDDEN = [/(^|\/)mutants\.ts$/, /^legacy\//, /^parity\//, /^eval\//, /^lib\//, /^scripts\//];
const ALLOWED_BARE = [/^@modelcontextprotocol\/sdk\//, /^zod$/, /^node:/];

const repoPath = (abs: string): string => relative(REPO, abs).split(sep).join("/");

type Graph = { files: string[]; bare: string[]; unresolved: string[] };

function walk(entry: string): Graph {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const unresolved: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        bare.add(spec);
        continue;
      }
      const target = resolve(dirname(file), spec);
      if (existsSync(target)) queue.push(target);
      else unresolved.push(`${repoPath(file)} -> ${spec}`);
    }
  }
  return { files: [...seen].map(repoPath).sort(), bare: [...bare].sort(), unresolved };
}

describe("production import graph from src/server/stdio.ts", () => {
  const graph = walk(ENTRY);

  it("walks a real graph (sanity: reaches the bridge, the decoder and mcpkit)", () => {
    expect(graph.files).toContain("src/server/createServer.ts");
    expect(graph.files).toContain("src/bridge/createBridge.ts");
    expect(graph.files).toContain("src/bridge/ops.ts");
    expect(graph.files).toContain("src/fixedwidth/money.ts");
    expect(graph.files).toContain("src/mcpkit/paths.ts");
    expect(graph.unresolved).toEqual([]);
  });

  it("reaches no mutant, oracle, harness, eval, lib or script module", () => {
    const hits = graph.files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
    expect(hits).toEqual([]);
  });

  it("stays inside src/{fixedwidth,mcpkit,bridge,server}", () => {
    const outside = graph.files.filter((f) => !ALLOWED_DIRS.some((d) => f.startsWith(d)));
    expect(outside).toEqual([]);
  });

  it("imports only the MCP SDK, zod and node: built-ins as packages", () => {
    const other = graph.bare.filter((s) => !ALLOWED_BARE.some((re) => re.test(s)));
    expect(other).toEqual([]);
  });

  it("no reached file reads process.env or process.argv", () => {
    const hits = graph.files.filter((f) => /\bprocess\s*\.\s*(?:env|argv)\b/.test(readFileSync(join(REPO, f), "utf8")));
    expect(hits).toEqual([]);
  });

  it("the specifier scan sees every import form", () => {
    const sample = [
      'import { a } from "./a.ts";',
      "import type { B } from '../b.ts';",
      'import {\n  c,\n  d,\n} from "./cd.ts";',
      'export { e } from "./e.ts";',
      'import "./side.ts";',
      'const m = await import("./dyn.ts");',
      '// import { gone } from "./commented.ts";',
    ].join("\n");
    expect(specifiers(sample).sort()).toEqual(["../b.ts", "./a.ts", "./cd.ts", "./dyn.ts", "./e.ts", "./side.ts"]);
  });
});
