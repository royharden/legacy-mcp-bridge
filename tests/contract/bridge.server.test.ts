// Contract: the MCP server over an in-memory transport registers exactly the five read-only tools with strict input
// schemas and output schemas, returns structuredContent + text for a call, reports bridge errors as isError, and refuses
// the unknown tool account_post.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../../src/bridge/createBridge.ts";
import { createServer } from "../../src/server/createServer.ts";
import { testBridge } from "../helpers/bridgeDataset.ts";
import { explicitRefusal, refusalResult, type RefusalKind } from "../helpers/mcpRefusal.ts";

const server = createServer(testBridge());
const client = new Client({ name: "contract-test", version: "0.0.0" }, { capabilities: {} });

beforeAll(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client.close();
  await server.close();
});

/** True when the call is refused, whichever way the SDK version reports it (isError result or rejected request). */
async function refused(name: string, args: Record<string, unknown>, kind: RefusalKind): Promise<boolean> {
  try {
    const r = await client.callTool({ name, arguments: args });
    return refusalResult(r, kind);
  } catch (error) {
    if (explicitRefusal(error, kind, name)) return true;
    throw error;
  }
}

describe("MCP server", () => {
  it("lists exactly the five tools, read-only, strict inputs, with output schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect((t.inputSchema as { additionalProperties?: unknown }).additionalProperties, t.name).toBe(false);
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("returns structuredContent and the same data as JSON text", async () => {
    const r = await client.callTool({ name: "account_get", arguments: { account_id: "0000000040" } });
    expect(r.isError ?? false).toBe(false);
    const structured = r.structuredContent as { data: { source: string; tax_id: string } };
    expect(structured.data.source).toBe("ACCTMSTR#1");
    expect(structured.data.tax_id).toBe("***-**-1234");
    const content = r.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]?.text ?? "null")).toEqual(structured);
  });

  it("reports a bridge error as isError with {code, message, field}", async () => {
    const r = await client.callTool({ name: "account_get", arguments: { account_id: "0000000739" } });
    expect(r.isError).toBe(true);
    const content = r.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0]?.text ?? "null")).toMatchObject({ error: { code: "not_found", field: "account_id" } });
  });

  it("rejects invalid arguments (the SDK or the bridge refuses them)", async () => {
    expect(await refused("account_get", { account_id: "1", extra: true }, "bad_argument")).toBe(true);
  });

  it("refuses the unknown tool account_post", async () => {
    expect(await refused("account_post", { account_id: "0000000040" }, "unknown_tool")).toBe(true);
  });
});
