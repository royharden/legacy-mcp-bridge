// tests/unit/mcpkit/mask-cap.test.ts — tax-id masking and the 65,536-byte cap measured on the MASKED complete result,
// dropping whole rows (never mid-JSON) and raising over_cap when not even zero rows fit.
import { describe, expect, it } from "vitest";
import { CAP_BYTES, fitRows, jsonBytes } from "../../../src/mcpkit/cap.ts";
import { ToolError } from "../../../src/mcpkit/errors.ts";
import { maskDeep, maskTaxId } from "../../../src/mcpkit/mask.ts";

describe("maskTaxId", () => {
  it("plants ACCTMSTR#3: 900421234 ⇒ ***-**-1234", () => {
    expect(maskTaxId("900421234")).toBe("***-**-1234");
  });
  it("blank stays blank; trailing padding is ignored", () => {
    expect(maskTaxId("")).toBe("");
    expect(maskTaxId("         ")).toBe("");
    expect(maskTaxId("900000052   ")).toBe("***-**-0052");
  });
  it("is idempotent", () => {
    expect(maskTaxId(maskTaxId("900000289"))).toBe("***-**-0289");
  });
});

describe("maskDeep", () => {
  it("masks every tax_id at any depth without mutating the input", () => {
    const input = {
      data: [{ tax_id: "900421234", name: { text: "HARTLEY", untrusted_text: true } }, { tax_id: "900000044" }],
      nested: { deeper: [{ tax_id: "900000700" }] },
      count: 2,
    };
    const out = maskDeep(input);
    expect(out.data[0]?.tax_id).toBe("***-**-1234");
    expect(out.data[1]?.tax_id).toBe("***-**-0044");
    expect(out.nested.deeper[0]?.tax_id).toBe("***-**-0700");
    expect(out.count).toBe(2);
    expect(input.data[0]?.tax_id).toBe("900421234");
    expect(JSON.stringify(out)).not.toMatch(/9004212|9000000|9000007/);
  });
  it("leaves non-string tax_id values and other keys alone", () => {
    expect(maskDeep({ tax_id: null, taxid: "900421234" })).toEqual({ tax_id: null, taxid: "900421234" });
  });
});

type Row = { source: string; tax_id: string };
const rowsOf = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({ source: `ACCTMSTR#${i + 1}`, tax_id: `9000${String(i).padStart(5, "0")}` }));

/**
 * A build function shaped like a tool result: structured content plus a text summary and a truncation marker. maskDeep
 * only reaches `tax_id` keys, so a text block must never embed raw row JSON (the bridge masks rows before building).
 */
function builder(all: Row[]): (rows: Row[]) => object {
  return (rows) => {
    const structured = { data: rows, truncated: rows.length < all.length, next_cursor: rows.length < all.length ? "c" : null };
    return { structuredContent: structured, content: [{ type: "text", text: `${rows.length} of ${all.length} rows` }] };
  };
}

describe("fitRows", () => {
  it("CAP_BYTES is 65,536", () => {
    expect(CAP_BYTES).toBe(65536);
  });

  it("keeps everything when the masked result fits", () => {
    const all = rowsOf(5);
    const r = fitRows(builder(all), all);
    expect(r.kept).toBe(5);
    expect(r.truncated).toBe(false);
    expect(r.bytes).toBe(jsonBytes(r.payload));
  });

  it("measures the masked payload: a cap equal to the masked size fits, one byte less truncates", () => {
    const all = rowsOf(20);
    // Masked tax ids (11 chars) are longer than raw ones (9 chars), so measuring the raw payload would wrongly fit at cap-1.
    const maskedSize = jsonBytes(maskDeep(builder(all)(all)));
    const rawSize = jsonBytes(builder(all)(all));
    expect(maskedSize).toBeGreaterThan(rawSize);

    const exact = fitRows(builder(all), all, { cap: maskedSize });
    expect(exact.kept).toBe(20);
    expect(exact.truncated).toBe(false);
    expect(JSON.stringify(exact.payload)).toContain("***-**-");
    expect(JSON.stringify(exact.payload)).not.toContain("900000001");

    const under = fitRows(builder(all), all, { cap: maskedSize - 1 });
    expect(under.truncated).toBe(true);
    expect(under.kept).toBeLessThan(20);
    expect(under.bytes).toBeLessThanOrEqual(maskedSize - 1);
  });

  it("drops whole rows: the kept rows are an exact prefix and the payload is valid JSON", () => {
    const all = rowsOf(200);
    const cap = 4000;
    const r = fitRows(builder(all), all, { cap });
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBeLessThanOrEqual(cap);
    const parsed = JSON.parse(JSON.stringify(r.payload)) as { structuredContent: { data: Row[]; truncated: boolean } };
    expect(parsed.structuredContent.truncated).toBe(true);
    expect(parsed.structuredContent.data.map((x) => x.source)).toEqual(all.slice(0, r.kept).map((x) => x.source));
    // Maximal: one more row would not fit.
    expect(jsonBytes(maskDeep(builder(all)(all.slice(0, r.kept + 1))))).toBeGreaterThan(cap);
  });

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    expect(jsonBytes("é")).toBe(4);
    expect(jsonBytes("€")).toBe(5);
  });

  it("raises over_cap when even zero rows do not fit", () => {
    const all = rowsOf(3);
    const big = (rows: Row[]): object => ({ mandatory: "x".repeat(500), rows });
    let code: string | undefined;
    try {
      fitRows(big, all, { cap: 100 });
    } catch (e) {
      code = e instanceof ToolError ? e.code : "other";
    }
    expect(code).toBe("over_cap");
  });

  it("uses the supplied mask function (bridge ops override)", () => {
    const all = rowsOf(2);
    const r = fitRows(builder(all), all, { mask: (v) => v });
    expect(JSON.stringify(r.payload)).toContain("900000001");
  });

  it("with zero rows input returns kept 0, not truncated", () => {
    const r = fitRows(builder([]), []);
    expect(r).toMatchObject({ kept: 0, truncated: false });
  });
});
