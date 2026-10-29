// src/mcpkit/audit.ts — append-only JSONL audit of tool calls holding hashes and sizes only: never argument or result
// bodies, never raw ids. An unwritable audit path is reported on stderr and surfaces as ToolError internal (never stdout).
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ToolError } from "./errors.ts";
import { logErr } from "./logger.ts";

export const AUDIT_KEYS = ["tool", "args_sha256", "result_sha256", "bytes", "ms", "error_code", "ts"] as const;

export type AuditEntry = {
  tool: string;
  args: unknown;
  result: unknown;
  bytes: number;
  ms: number;
  error_code: string | null;
};

export type AuditLine = {
  tool: string;
  args_sha256: string;
  result_sha256: string;
  bytes: number;
  ms: number;
  error_code: string | null;
  ts: string;
};

export type AuditLog = { record(e: AuditEntry): void };

const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** SHA-256 hex of the JSON form (bigints as decimal strings, undefined as null). */
export function sha256Json(value: unknown): string {
  const json = JSON.stringify(value === undefined ? null : value, (_k, v: unknown) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  return createHash("sha256").update(json ?? "null", "utf8").digest("hex");
}

function errCode(e: unknown): string {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code: unknown }).code;
    if (typeof c === "string") return c;
  }
  return "error";
}

export function createAuditLog(path: string | null): AuditLog {
  if (path === null) return { record: () => undefined };
  return {
    record(e: AuditEntry): void {
      const line: AuditLine = {
        // A client-supplied unknown tool name is not echoed unless it looks like a tool name.
        tool: TOOL_NAME_RE.test(e.tool) ? e.tool : "<invalid>",
        args_sha256: sha256Json(e.args),
        result_sha256: sha256Json(e.result),
        bytes: e.bytes,
        ms: e.ms,
        error_code: e.error_code,
        ts: new Date().toISOString(),
      };
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
      } catch (err) {
        logErr(`audit log write failed (${errCode(err)}): ${path}`);
        throw new ToolError("internal", "audit log unavailable");
      }
    },
  };
}
