// src/mcpkit/errors.ts — the structured tool error and its client payload {code, message, field?}. Unexpected exceptions map
// to "internal" with a fixed message: no stack traces, record bytes or paths ever reach an MCP client.

export const TOOL_ERROR_CODES = [
  "bad_argument",
  "not_found",
  "invalid_cursor",
  "over_cap",
  "path_rejected",
  "unknown_tool",
  "internal",
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export type ErrorPayload = { code: ToolErrorCode; message: string; field?: string };

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  readonly field?: string;

  constructor(code: ToolErrorCode, message: string, field?: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

export const INTERNAL_MESSAGE = "internal error";

export function toErrorPayload(e: unknown): ErrorPayload {
  if (e instanceof ToolError) {
    const payload: ErrorPayload = { code: e.code, message: e.message };
    if (e.field !== undefined) payload.field = e.field;
    return payload;
  }
  return { code: "internal", message: INTERNAL_MESSAGE };
}
