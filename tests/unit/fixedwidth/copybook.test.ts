// tests/unit/fixedwidth/copybook.test.ts — copybook subset grammar (9V999, S9(9)V99, S9(7)V99 COMP-3), named rejections
// (REDEFINES / OCCURS / COPY and others), layout JSON validation and layout-vs-copybook agreement. The .cpy and layouts
// JSON under fixtures/ are hand-written source contracts (freeze 1A), not generated data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkLayoutAgainstCopybook,
  copybookRecordLength,
  parseCopybook,
} from "../../../src/fixedwidth/copybook.ts";
import { LayoutMismatch, UnsupportedClause } from "../../../src/fixedwidth/errors.ts";
import { loadLayout, loadLayoutFile } from "../../../src/fixedwidth/layout.ts";

const fixture = (rel: string): string => fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url));

const ACCTMSTR_CPY = [
  "      * ACCTMSTR.cpy - account master record (synthetic data only).",
  "      * Fixed length 100 bytes, no record delimiter.",
  "       01  ACCTMSTR-REC.",
  "           05  ACCT-ID             PIC 9(10).",
  "           05  ACCT-NAME           PIC X(25).",
  "           05  ACCT-STATUS         PIC X.",
  "           05  OPEN-DATE           PIC 9(6).",
  "           05  BALANCE             PIC S9(9)V99.",
  "           05  CREDIT-LIMIT        PIC S9(7)V99 COMP-3.",
  "           05  RATE                PIC 9V999.",
  "           05  TAX-ID              PIC X(9).",
  "           05  MEMO                PIC X(25).",
  "           05  FILLER              PIC X(4).",
  "",
].join("\n");

/** A minimal copybook around one statement, for rejection tests. */
const withLine = (stmt: string): string =>
  ["       01  T-REC.", "           05  A               PIC X(2).", `           ${stmt}`, ""].join("\n");

function clauseOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof UnsupportedClause) return e.clause;
    return `unexpected:${String(e)}`;
  }
  return "no error";
}

describe("parseCopybook subset grammar", () => {
  const fields = parseCopybook(ACCTMSTR_CPY);

  it("parses all ten ACCTMSTR items with contiguous zero-based offsets summing to 100", () => {
    expect(fields.map((f) => f.name)).toEqual([
      "ACCT-ID", "ACCT-NAME", "ACCT-STATUS", "OPEN-DATE", "BALANCE", "CREDIT-LIMIT", "RATE", "TAX-ID", "MEMO", "FILLER",
    ]);
    expect(fields.map((f) => f.offset)).toEqual([0, 10, 35, 36, 42, 53, 58, 62, 71, 96]);
    expect(fields.map((f) => f.length)).toEqual([10, 25, 1, 6, 11, 5, 4, 9, 25, 4]);
    expect(copybookRecordLength(fields)).toBe(100);
  });

  it("S9(9)V99 is signed zoned, 11 digits, scale 2, 11 bytes", () => {
    expect(fields[4]).toMatchObject({ name: "BALANCE", kind: "zoned", digits: 11, scale: 2, signed: true, length: 11 });
  });

  it("S9(7)V99 COMP-3 is packed, 9 digits, scale 2, floor(9/2)+1 = 5 bytes", () => {
    expect(fields[5]).toMatchObject({ kind: "packed", digits: 9, scale: 2, signed: true, length: 5, pic: "S9(7)V99 COMP-3" });
  });

  it("9V999 is unsigned zoned, 4 digits, scale 3", () => {
    expect(fields[6]).toMatchObject({ name: "RATE", kind: "zoned", digits: 4, scale: 3, signed: false, length: 4 });
  });

  it("X defaults to one byte; records one-based line numbers", () => {
    expect(fields[2]).toMatchObject({ kind: "alnum", length: 1, line: 6 });
    expect(fields[0]?.line).toBe(4);
  });

  it("packed length for even digit counts: S9(4) COMP-3 = 3 bytes, 9(5) COMP-3 = 3 bytes", () => {
    const f = parseCopybook(withLine("05  B               PIC S9(4) COMP-3."));
    expect(f[1]).toMatchObject({ kind: "packed", digits: 4, length: 3, offset: 2 });
    const g = parseCopybook(withLine("05  B               PIC 9(5) COMP-3."));
    expect(g[1]).toMatchObject({ digits: 5, length: 3, signed: false });
  });

  it("accepts CRLF line endings", () => {
    expect(parseCopybook(ACCTMSTR_CPY.replace(/\n/g, "\r\n"))).toEqual(fields);
  });

  it("repeated FILLER items are legal", () => {
    const f = parseCopybook(
      ["       01  R.", "           05  FILLER  PIC X(2).", "           05  FILLER  PIC X(3).", ""].join("\n"),
    );
    expect(f.map((x) => [x.name, x.offset, x.length])).toEqual([["FILLER", 0, 2], ["FILLER", 2, 3]]);
  });
});

describe("parseCopybook named rejections (UnsupportedClause)", () => {
  it("REDEFINES", () => {
    expect(clauseOf(() => parseCopybook(withLine("05  B REDEFINES A  PIC 9(2).")))).toBe("REDEFINES");
  });
  it("OCCURS", () => {
    expect(clauseOf(() => parseCopybook(withLine("05  B  PIC X OCCURS 3.")))).toBe("OCCURS");
  });
  it("COPY", () => {
    expect(clauseOf(() => parseCopybook(withLine("COPY OTHERBOOK.")))).toBe("COPY");
  });
  it("VALUE, COMP, BINARY, SIGN SEPARATE", () => {
    expect(clauseOf(() => parseCopybook(withLine("05  B  PIC X VALUE 'Y'.")))).toBe("VALUE");
    expect(clauseOf(() => parseCopybook(withLine("05  B  PIC 9(4) COMP.")))).toBe("COMP");
    expect(clauseOf(() => parseCopybook(withLine("05  B  PIC 9(4) BINARY.")))).toBe("BINARY");
    expect(clauseOf(() => parseCopybook(withLine("05  B  PIC S9(4) SIGN LEADING SEPARATE.")))).toBe("SIGN");
  });
  it("levels other than 01/05, group items, COMP-3 on X, missing period, foreign PIC", () => {
    expect(clauseOf(() => parseCopybook(withLine("10  B  PIC X.")))).toBe("LEVEL 10");
    expect(clauseOf(() => parseCopybook(withLine("05  B.")))).toBe("GROUP");
    expect(clauseOf(() => parseCopybook(withLine("05  B  PIC X(3) COMP-3.")))).toBe("COMP-3");
    expect(clauseOf(() => parseCopybook(withLine("05  B  PIC X(3)")))).toBe("SYNTAX");
    expect(clauseOf(() => parseCopybook(withLine("05  B  PIC Z(3)9.")))).toBe("PIC");
    expect(clauseOf(() => parseCopybook(withLine("05  B  PIC 9(0).")))).toBe("PIC");
  });
  it("a second 01 record and sequence numbers in columns 1-6", () => {
    expect(clauseOf(() => parseCopybook(withLine("01  OTHER-REC.")))).toBe("LEVEL 01");
    expect(clauseOf(() => parseCopybook("000100 01  R.\n"))).toBe("SEQUENCE-AREA");
  });
  it("empty copybook", () => {
    expect(clauseOf(() => parseCopybook("      * only a comment\n"))).toBe("SYNTAX");
  });
});

describe("layout JSON vs copybook", () => {
  for (const [cpy, json] of [
    ["ACCTMSTR.cpy", "acctmstr.json"],
    ["TRANS.cpy", "trans.json"],
  ] as const) {
    it(`fixtures/layouts/${json} agrees with fixtures/copybooks/${cpy}`, () => {
      const layout = loadLayoutFile(fixture(`layouts/${json}`));
      const fields = parseCopybook(readFileSync(fixture(`copybooks/${cpy}`), "utf8"));
      expect(() => checkLayoutAgainstCopybook(layout, fields)).not.toThrow();
      expect(copybookRecordLength(fields)).toBe(layout.recordLength);
    });
  }

  it("the inline ACCTMSTR literal matches the committed acctmstr.json", () => {
    const layout = loadLayoutFile(fixture("layouts/acctmstr.json"));
    expect(() => checkLayoutAgainstCopybook(layout, parseCopybook(ACCTMSTR_CPY))).not.toThrow();
  });

  it("a copybook length change is a LayoutMismatch", () => {
    const layout = loadLayoutFile(fixture("layouts/acctmstr.json"));
    const changed = ACCTMSTR_CPY.replace("PIC S9(9)V99.", "PIC S9(9)V9. ");
    expect(() => checkLayoutAgainstCopybook(layout, parseCopybook(changed))).toThrow(LayoutMismatch);
  });

  it("a layout scale or type change is a LayoutMismatch", () => {
    const layout = loadLayoutFile(fixture("layouts/acctmstr.json"));
    const fields = parseCopybook(ACCTMSTR_CPY);
    const scaled = structuredClone(layout);
    const rate = scaled.fields[6];
    if (rate === undefined) throw new Error("fixture layout lost RATE");
    rate.scale = 2;
    expect(() => checkLayoutAgainstCopybook(scaled, fields)).toThrow(LayoutMismatch);
    const retyped = structuredClone(layout);
    const credit = retyped.fields[5];
    if (credit === undefined) throw new Error("fixture layout lost CREDIT-LIMIT");
    credit.type = "zoned";
    expect(() => checkLayoutAgainstCopybook(retyped, fields)).toThrow(LayoutMismatch);
  });

  it("loadLayout rejects non-contiguous offsets and a wrong recordLength", () => {
    const json = JSON.parse(readFileSync(fixture("layouts/trans.json"), "utf8")) as {
      recordLength: number;
      fields: { offset: number }[];
    };
    const gap = structuredClone(json);
    const third = gap.fields[2];
    if (third === undefined) throw new Error("fixture layout lost TRAN-DATE");
    third.offset += 1;
    expect(() => loadLayout(gap)).toThrow(LayoutMismatch);
    const longer = structuredClone(json);
    longer.recordLength = 81;
    expect(() => loadLayout(longer)).toThrow(LayoutMismatch);
    expect(() => loadLayout(json)).not.toThrow();
  });

  it("loadLayout rejects unknown field types and a zoned length/digits disagreement", () => {
    const json = JSON.parse(readFileSync(fixture("layouts/acctmstr.json"), "utf8")) as {
      fields: { type: string; digits?: number }[];
    };
    const badType = structuredClone(json);
    const f0 = badType.fields[0];
    if (f0 === undefined) throw new Error("fixture layout lost ACCT-ID");
    f0.type = "binary";
    expect(() => loadLayout(badType)).toThrow(LayoutMismatch);
    const badDigits = structuredClone(json);
    const f4 = badDigits.fields[4];
    if (f4 === undefined) throw new Error("fixture layout lost BALANCE");
    f4.digits = 10;
    expect(() => loadLayout(badDigits)).toThrow(LayoutMismatch);
  });
});
