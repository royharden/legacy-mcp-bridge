// src/mcpkit/logger.ts — the single diagnostics sink. stdout carries MCP protocol frames only, so everything goes to stderr.

export function logErr(msg: string): void {
  process.stderr.write(`[legacy-mcp-bridge] ${msg}\n`);
}
