// One actual subprocess protocol test: requires an existing build and frozen fixtures; never builds or generates them.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { explicitRefusal, refusalResult } from "../helpers/mcpRefusal.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const TOOLS = ["describe_layouts", "account_get", "accounts_find", "transactions_list", "aging_summary"];

describe("built MCP stdio server", () => {
  it("starts from an unrelated cwd, lists five tools, reads the negative trap and explicitly refuses writes", async () => {
    const entry = join(REPO, "dist", "server", "stdio.js");
    for (const path of [entry, join(REPO, "fixtures", "legacy", "ACCTMSTR.DAT"), join(REPO, "fixtures", "legacy", "TRANS.DAT")]) {
      expect(existsSync(path), `missing prerequisite ${path}; generate/freeze fixtures and run npm run build before test:stdio`).toBe(true);
    }
    const transport = new StdioClientTransport({
      command: process.execPath, args: [entry], cwd: mkdtempSync(join(tmpdir(), "lmb-stdio-")), stderr: "pipe",
    });
    const client = new Client({ name: "lmb-stdio-test", version: "0.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
      const result = await client.callTool({ name: "account_get", arguments: { account_id: "0000000042" } });
      expect(result.isError ?? false).toBe(false);
      expect(result.structuredContent).toMatchObject({ data: {
        source: "ACCTMSTR#3", account_id: "0000000042", balance_minor: -123456,
        tax_id: "***-**-1234", monthly_interest_minor: -360,
      } });
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content.find((part) => part.type === "text");
      expect(text?.type).toBe("text");
      if (text?.type !== "text" || typeof text.text !== "string") throw new Error("missing JSON text result");
      expect(JSON.parse(text.text)).toEqual(result.structuredContent);
      let refused = false;
      try {
        refused = refusalResult(await client.callTool({ name: "account_post", arguments: { account_id: "0000000042" } }), "unknown_tool");
      } catch (error) {
        if (!explicitRefusal(error, "unknown_tool", "account_post")) throw error;
        refused = true;
      }
      expect(refused).toBe(true);
      // A still-live protocol connection distinguishes an actual refusal from a process or transport failure.
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
    } finally {
      try { await client.close(); }
      finally { await transport.close(); }
    }
  });
});
