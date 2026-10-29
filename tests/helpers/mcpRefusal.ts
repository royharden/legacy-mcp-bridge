// Recognize explicit MCP refusals; broken transports and unrelated request errors must propagate as failures.
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export type RefusalKind = "unknown_tool" | "bad_argument";

export function explicitRefusal(error: unknown, kind: RefusalKind, tool: string): boolean {
  if (!(error instanceof McpError)) return false;
  if (kind === "bad_argument") return error.code === ErrorCode.InvalidParams && /argument|parameter|validation/i.test(error.message);
  return (error.code === ErrorCode.InvalidParams || error.code === ErrorCode.MethodNotFound) &&
    error.message.includes(tool) && /unknown|not found|not registered/i.test(error.message);
}

export function refusalResult(result: { isError?: unknown; content?: unknown }, kind: RefusalKind): boolean {
  if (result.isError !== true) return false;
  const text = JSON.stringify(result.content);
  return kind === "unknown_tool" ? /unknown_tool|unknown tool|tool[^\n]*not found/i.test(text ?? "") :
    /bad_argument|invalid[^\n]*(argument|parameter)|validation/i.test(text ?? "");
}
