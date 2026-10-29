// src/bridge/cursor.ts — opaque page cursors: base64url(JSON {v:1, tool, filterHash, fixtureDigest, nextRecord}).
// nextRecord is the zero-based physical index of the first row not yet returned. Every field is validated on the way back
// in; a wrong tool or filter, a stale fixture digest, a malformed or non-canonical token ⇒ invalid_cursor. The caller also
// checks that the record at nextRecord matches the filter, so a cursor can only resume exactly where a page ended.
import { createHash } from "node:crypto";
import { ToolError } from "../mcpkit/errors.ts";

export type CursorTool = "accounts_find" | "transactions_list";

export type CursorPayload = {
  v: 1;
  tool: CursorTool;
  filterHash: string;
  fixtureDigest: string;
  nextRecord: number;
};

const KEYS = ["v", "tool", "filterHash", "fixtureDigest", "nextRecord"] as const;
const TOKEN_RE = /^[A-Za-z0-9_-]+$/;
const HEX_RE = /^[0-9a-f]+$/;

/** Hash of the filter that defines the match set (limit and cursor excluded: they do not change the match). */
export function filterHash(tool: CursorTool, filter: Readonly<Record<string, string | null>>): string {
  const canonical = JSON.stringify([tool, Object.keys(filter).sort().map((k) => [k, filter[k] ?? null])]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32);
}

export function encodeCursor(p: CursorPayload): string {
  // Fixed key order so encoding is canonical and a decoded token can be re-encoded for comparison.
  const json = JSON.stringify({
    v: p.v,
    tool: p.tool,
    filterHash: p.filterHash,
    fixtureDigest: p.fixtureDigest,
    nextRecord: p.nextRecord,
  });
  return Buffer.from(json, "utf8").toString("base64url");
}

function invalid(message: string): never {
  throw new ToolError("invalid_cursor", message, "cursor");
}

/**
 * Validate a cursor against the current call and return its nextRecord.
 * `recordCount` is the number of records in the scanned file; a valid nextRecord lies in [1, recordCount - 1]
 * (0 would be the first page, which never carries a cursor).
 */
export function decodeCursor(
  token: string,
  expect: { tool: CursorTool; filterHash: string; fixtureDigest: string; recordCount: number },
): number {
  if (!TOKEN_RE.test(token)) invalid("cursor is not a token returned by this tool");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    invalid("cursor is not a token returned by this tool");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("cursor payload is not an object");
  const o = parsed as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) invalid("cursor payload has unexpected fields");

  const { v, tool, filterHash: fh, fixtureDigest, nextRecord } = o;
  if (v !== 1) invalid("unsupported cursor version");
  if (tool !== expect.tool) invalid("cursor belongs to a different tool");
  if (typeof fh !== "string" || !HEX_RE.test(fh) || fh !== expect.filterHash) {
    invalid("cursor belongs to a different filter");
  }
  if (typeof fixtureDigest !== "string" || !HEX_RE.test(fixtureDigest) || fixtureDigest !== expect.fixtureDigest) {
    invalid("cursor is stale: the data files have changed");
  }
  if (
    typeof nextRecord !== "number" ||
    !Number.isSafeInteger(nextRecord) ||
    nextRecord < 1 ||
    nextRecord >= expect.recordCount
  ) {
    invalid("cursor position is out of range");
  }
  const payload: CursorPayload = { v: 1, tool: expect.tool, filterHash: fh, fixtureDigest, nextRecord };
  if (encodeCursor(payload) !== token) invalid("cursor is not in canonical form");
  return nextRecord;
}
