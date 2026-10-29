// src/server/stdio.ts — the process entry: node <repo>/dist/server/stdio.js (or src/server/stdio.ts via strip-types).
// Defaults only: the canonical data view <repo>/fixtures/legacy, audit to <repo>/results/audit/audit.jsonl, no ops override,
// no env var or flag that selects a mutant or another data view. stdout carries MCP frames only; diagnostics go to stderr.
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridge } from "../bridge/createBridge.ts";
import { findPackageRoot } from "../bridge/packageRoot.ts";
import { logErr } from "../mcpkit/logger.ts";
import { createServer } from "./createServer.ts";

async function main(): Promise<void> {
  const root = findPackageRoot(import.meta.url);
  const bridge = createBridge({
    dataRoot: join(root, "fixtures", "legacy"),
    auditPath: join(root, "results", "audit", "audit.jsonl"),
  });
  const server = createServer(bridge);
  await server.connect(new StdioServerTransport());
  logErr("stdio server ready (five read-only tools over the canonical synthetic fixtures)");
}

main().catch((error: unknown) => {
  logErr(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
