// Literal newline-free byte fixtures prove escaped result caps and continuation without any generated dataset.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGenericTools, GENERIC_CAP_BYTES, type GenericResult } from "../../eval/genericTools.ts";

function root(data: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "lmb-raw-"));
  writeFileSync(join(dir, "ACCTMSTR.DAT"), data);
  writeFileSync(join(dir, "TRANS.DAT"), data);
  return dir;
}
function ok(result: GenericResult): Extract<GenericResult, { ok: true }> {
  if (!result.ok) throw new Error(result.error.message);
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(GENERIC_CAP_BYTES);
  expect(JSON.parse(result.text)).toEqual(result.structured);
  return result;
}
function unescape(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      expect(text.slice(i, i + 2)).toBe("\\x");
      bytes.push(Number.parseInt(text.slice(i + 2, i + 4), 16)); i += 3;
    } else bytes.push(text.charCodeAt(i));
  }
  return Buffer.from(bytes);
}

describe("bounded generic raw tools", () => {
  it("read_range caps the entire escaped result and resumes monotonically without losing bytes", async () => {
    const data = Buffer.concat([Buffer.alloc(4096, 0xff), Buffer.from('\\x00"HELLO', "latin1")]);
    const tools = createGenericTools({ dataRoot: root(data) });
    const chunks: Buffer[] = [];
    let offset = 0;
    let first = true;
    for (;;) {
      const r = ok(await tools.call("read_range", { file: "ACCTMSTR.DAT", offset, length: 4096 }));
      if (first) {
        expect(r.structured.truncated).toBe(true);
        expect(r.rawBytes).toBeLessThan(4096);
        first = false;
      }
      const chunk = unescape(String(r.structured.data));
      expect(r.rawBytes).toBe(chunk.length);
      chunks.push(chunk);
      const next = r.structured.next_offset;
      if (next === null) break;
      expect(typeof next).toBe("number");
      expect(next as number).toBeGreaterThan(offset);
      offset = next as number;
    }
    expect(Buffer.concat(chunks)).toEqual(data);
  });

  it("grep uses byte offsets on newline-free input, keeps overlapping matches and continues under the cap", async () => {
    const data = Buffer.alloc(1000, 0xff);
    const tools = createGenericTools({ dataRoot: root(data) });
    const offsets: number[] = [];
    let start = 0;
    for (;;) {
      const r = ok(await tools.call("grep", { file: "TRANS.DAT", literal: "\u00ff\u00ff", max_matches: 50, start_offset: start }));
      const matches = r.structured.matches as Array<{ offset: number; record_index: number; context_offset: number; context: string }>;
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.length).toBeLessThanOrEqual(50);
      for (const match of matches) {
        expect(match.record_index).toBe(Math.floor(match.offset / 80) + 1);
        expect(unescape(match.context)).toEqual(data.subarray(match.context_offset, Math.min(1000, match.offset + 2 + 40)));
        offsets.push(match.offset);
      }
      const next = r.structured.next_offset;
      if (next === null) break;
      expect(next as number).toBeGreaterThan(start);
      start = next as number;
    }
    expect(offsets).toEqual(Array.from({ length: 999 }, (_, i) => i));
  });

  it("allows only the two data files, enforces argument limits and explicitly rejects unknown tools", async () => {
    const tools = createGenericTools({ dataRoot: root(Buffer.from("NO NEWLINES HERE", "latin1")) });
    expect(tools.tools.map((t) => t.name)).toEqual(["read_range", "grep"]);
    for (const file of ["ACCTMSTR.cpy", "../ACCTMSTR.DAT", "/TRANS.DAT", "%2e%2e/TRANS.DAT"]) {
      expect(await tools.call("read_range", { file, offset: 0, length: 1 })).toMatchObject({ ok: false, error: { code: "bad_argument" } });
    }
    for (const args of [
      { file: "TRANS.DAT", offset: -1, length: 1 }, { file: "TRANS.DAT", offset: 0, length: 4097 },
      { file: "TRANS.DAT", offset: 100, length: 1 }, { file: "TRANS.DAT", offset: 0, length: 1, extra: true },
    ]) expect(await tools.call("read_range", args)).toMatchObject({ ok: false });
    expect(await tools.call("grep", { file: "TRANS.DAT", literal: "", max_matches: 1 })).toMatchObject({ ok: false });
    expect(await tools.call("grep", { file: "TRANS.DAT", literal: "X", max_matches: 51 })).toMatchObject({ ok: false });
    expect(await tools.call("copybooks", {})).toMatchObject({ ok: false, error: { code: "unknown_tool" } });
    expect(ok(await tools.call("grep", { file: "TRANS.DAT", literal: "ABSENT", max_matches: 50 })).structured).toMatchObject({ matches: [], next_offset: null });
  });
});
