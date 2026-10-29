// Negative controls: an outage/internal failure cannot be mistaken for a policy/unknown-tool refusal.
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { explicitRefusal, refusalResult } from "../helpers/mcpRefusal.ts";

describe("explicit MCP refusal recognition", () => {
  it("recognizes specific protocol refusals while rejecting transport and unrelated errors", () => {
    expect(explicitRefusal(new McpError(ErrorCode.InvalidParams, "Tool account_post not found"), "unknown_tool", "account_post")).toBe(true);
    expect(explicitRefusal(new McpError(ErrorCode.InvalidParams, "Invalid arguments"), "bad_argument", "account_get")).toBe(true);
    expect(explicitRefusal(new Error("connection closed"), "unknown_tool", "account_post")).toBe(false);
    expect(explicitRefusal(new McpError(ErrorCode.InternalError, "internal error"), "unknown_tool", "account_post")).toBe(false);
    expect(explicitRefusal(new McpError(ErrorCode.MethodNotFound, "tools/call not found"), "unknown_tool", "account_post")).toBe(false);
    expect(explicitRefusal(new McpError(ErrorCode.InvalidParams, "unrelated request error"), "bad_argument", "account_get")).toBe(false);
  });

  it("requires an isError result and a named refusal message/code", () => {
    expect(refusalResult({ isError: true, content: [{ type: "text", text: '{"error":{"code":"unknown_tool"}}' }] }, "unknown_tool")).toBe(true);
    expect(refusalResult({ isError: false, content: [] }, "unknown_tool")).toBe(false);
    expect(refusalResult({ isError: true, content: [{ text: "internal error" }] }, "unknown_tool")).toBe(false);
  });
});
