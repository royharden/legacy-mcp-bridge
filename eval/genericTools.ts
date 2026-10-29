// Benchmark-only raw byte access to the two data files. No decoder/copybook/aggregate access; cap the complete escaped result.
import { z } from "zod";
import { DATA_FILES, openFixedFile, resolveDataRoot, type DataFileName } from "../src/mcpkit/paths.ts";
import { ToolError } from "../src/mcpkit/errors.ts";
import type { ToolDefinition } from "../lib/providers/types.ts";

export const GENERIC_CAP_BYTES = 20480;
export type GenericResult = { ok: true; structured: Record<string, unknown>; text: string; rawBytes: number } |
  { ok: false; error: { code: string; message: string } };
const File = z.enum(DATA_FILES);
const Offset = z.number().int().nonnegative().safe();
const ReadInput = z.object({ file: File, offset: Offset, length: z.number().int().min(1).max(4096) }).strict();
const GrepInput = z.object({
  file: File, literal: z.string().min(1).max(256).regex(/^[\u0000-\u00ff]+$/), max_matches: z.number().int().min(1).max(50), start_offset: Offset.optional(),
}).strict();

function escapeBytes(bytes: Buffer): string {
  let out = "";
  for (const byte of bytes) out += byte >= 32 && byte <= 126 && byte !== 92 ? String.fromCharCode(byte) : `\\x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  return out;
}

function result(structured: Record<string, unknown>, rawBytes: number): Extract<GenericResult, { ok: true }> {
  return { ok: true, structured, text: JSON.stringify(structured), rawBytes };
}
function bytes(value: GenericResult): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function fit(build: (count: number) => Extract<GenericResult, { ok: true }>, maximum: number): Extract<GenericResult, { ok: true }> {
  let low = 0; let high = maximum;
  let best: Extract<GenericResult, { ok: true }> | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = build(mid);
    if (bytes(candidate) <= GENERIC_CAP_BYTES) { best = candidate; low = mid + 1; }
    else high = mid - 1;
  }
  if (best === undefined) throw new ToolError("over_cap", "raw tool metadata cannot fit under the result cap");
  return best;
}

const tools: ToolDefinition[] = [
  { name: "read_range", description: "Read at most 4096 raw bytes from one fixed data file. Non-printables/backslashes use \\xNN; next_offset continues the file. No decoded fields.", input_schema: {
    type: "object", properties: { file: { enum: [...DATA_FILES] }, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 4096 } }, required: ["file", "offset", "length"], additionalProperties: false,
  } },
  { name: "grep", description: "Literal Latin-1 byte search, at most 50 matches, with 40 raw bytes of context on either side. next_offset resumes without losing overlapping matches.", input_schema: {
    type: "object", properties: { file: { enum: [...DATA_FILES] }, literal: { type: "string", minLength: 1, maxLength: 256 }, max_matches: { type: "integer", minimum: 1, maximum: 50 }, start_offset: { type: "integer", minimum: 0 } }, required: ["file", "literal", "max_matches"], additionalProperties: false,
  } },
];

export function createGenericTools(options: { dataRoot: string }): { tools: ToolDefinition[]; call(name: string, args: unknown): Promise<GenericResult> } {
  const root = resolveDataRoot(options.dataRoot);
  return { tools: structuredClone(tools), async call(name, raw) {
    try {
      if (name === "read_range") {
        const input = ReadInput.safeParse(raw);
        if (!input.success) throw new ToolError("bad_argument", "invalid read_range arguments");
        const { file, offset, length } = input.data;
        const data = openFixedFile(root, file);
        if (offset > data.length) throw new ToolError("bad_argument", "offset is past end of file");
        const wanted = Math.min(length, data.length - offset);
        const out = fit((count) => result({ file, offset, data: escapeBytes(data.subarray(offset, offset + count)),
          next_offset: offset + count < data.length ? offset + count : null, truncated: count < wanted }, count), wanted);
        if (wanted > 0 && out.rawBytes === 0) throw new ToolError("over_cap", "no raw bytes fit under cap");
        return out;
      }
      if (name === "grep") {
        const input = GrepInput.safeParse(raw);
        if (!input.success) throw new ToolError("bad_argument", "invalid grep arguments");
        const { file, literal, max_matches } = input.data;
        const start = input.data.start_offset ?? 0;
        const data = openFixedFile(root, file);
        if (start > data.length) throw new ToolError("bad_argument", "start_offset is past end of file");
        const needle = Buffer.from(literal, "latin1");
        const width: Record<DataFileName, number> = { "ACCTMSTR.DAT": 100, "TRANS.DAT": 80 };
        const matches: Array<{ offset: number; record_index: number; context_offset: number; context: string; raw: number }> = [];
        let at = start;
        while (matches.length <= max_matches) {
          const found = data.indexOf(needle, at);
          if (found < 0) break;
          const from = Math.max(0, found - 40); const to = Math.min(data.length, found + needle.length + 40);
          matches.push({ offset: found, record_index: Math.floor(found / width[file]) + 1, context_offset: from, context: escapeBytes(data.subarray(from, to)), raw: to - from });
          at = found + 1;
        }
        const out = fit((count) => {
          const kept = matches.slice(0, count);
          const next = matches[count]?.offset ?? null;
          return result({ file, matches: kept.map((match) => ({ offset: match.offset, record_index: match.record_index,
            context_offset: match.context_offset, context: match.context })), next_offset: next, truncated: next !== null },
            kept.reduce((sum, match) => sum + match.raw, 0));
        }, Math.min(max_matches, matches.length));
        const list = out.structured.matches;
        if (matches.length > 0 && Array.isArray(list) && list.length === 0) throw new ToolError("over_cap", "no match context fits under cap");
        return out;
      }
      throw new ToolError("unknown_tool", "unknown generic tool; only read_range and grep exist");
    } catch (error) {
      return { ok: false, error: error instanceof ToolError ? { code: error.code, message: error.message } : { code: "internal", message: "raw file access failed" } };
    }
  } };
}
