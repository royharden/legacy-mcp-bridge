// src/server/createServer.ts — MCP server factory over a Bridge. Registers exactly the five read-only tools (strict zod
// input, zod output shape) and maps bridge results to CallToolResult: success ⇒ text (JSON of the masked structured content)
// + structuredContent; failure ⇒ isError with {error: {code, message, field?}}. A tool name outside the five is refused
// (the SDK rejects names that were never registered; the bridge refuses them too).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Bridge, ToolDef, ToolName, ToolResult } from "../bridge/createBridge.ts";

export const SERVER_NAME = "legacy-mcp-bridge";
export const SERVER_VERSION = "0.1.0";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

export function toCallToolResult(result: ToolResult): CallToolResult {
  if (result.ok) {
    return { content: [{ type: "text", text: result.text }], structuredContent: result.structured };
  }
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: result.error }) }] };
}

export function createServer(bridge: Bridge): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const defs = new Map<string, ToolDef>(bridge.tools.map((t) => [t.name, t]));

  const register = (name: ToolName): void => {
    const def = defs.get(name);
    if (def === undefined) throw new Error(`bridge does not provide tool ${name}`);
    server.registerTool(
      name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        outputSchema: def.outputSchema.shape,
        annotations: READ_ONLY,
      },
      async (args: unknown): Promise<CallToolResult> => toCallToolResult(await bridge.call(name, args)),
    );
  };

  // Exactly five registrations; nothing else is exposed (no write tool exists).
  register("describe_layouts");
  register("account_get");
  register("accounts_find");
  register("transactions_list");
  register("aging_summary");

  if (defs.size !== 5) throw new Error(`bridge exposes ${defs.size} tools; expected exactly 5`);
  return server;
}
