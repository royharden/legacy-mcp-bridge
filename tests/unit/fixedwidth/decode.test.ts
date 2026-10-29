// tests/unit/fixedwidth/decode.test.ts — text trimming (trailing padding only, internal double spaces kept, full-width
// values whole), low-values never exposed, and whole-record decoding of plants.json records built as literal bytes.
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeRecord, decodeText } from "../../../src/fixedwidth/decode.ts";
import { BadDate, BadSign, LayoutMismatch } from "../../../src/fixedwidth/errors.ts";
import { loadLayoutFile } from "../../../src/fixedwidth/layout.ts";
import { acctRecord, ascii, hex, tranRecord } from "../../helpers/fixedwidthBytes.ts";

const layoutPath = (name: string): string =>
  fileURLToPath(new URL(`../../../fixtures/layouts/${name}`, import.meta.url));
const ACCT = loadLayoutFile(layoutPath("acctmstr.json"));
const TRANS = loadLayoutFile(layoutPath("trans.json"));

// plants.json ACCTMSTR#3 (overpunch_negative, tax_id_mask, trailing_padding)
const REC3 = acctRecord({
  id: "0000000042",
  name: "HARTLEY MERCANTILE LTD",
  balance: "0000012345O",
  creditHex: "000250000C",
  taxId: "900421234",
  memo: "OVERDRAWN - REVIEW",
});

describe("decodeText", () => {
  it("trims only trailing padding: plants ACCTMSTR#3 name has 3 padding bytes", () => {
    expect(decodeText(REC3, 10, 25)).toBe("HARTLEY MERCANTILE LTD");
  });
  it("keeps internal double spaces and a value that fills the field (plants ACCTMSTR#9)", () => {
    const v = decodeText(ascii("SMITH  JONES  AND PARTNER"), 0, 25);
    expect(v).toBe("SMITH  JONES  AND PARTNER");
    expect(v.length).toBe(25);
  });
  it("keeps leading spaces", () => {
    expect(decodeText(ascii("  LEAD  "), 0, 8)).toBe("  LEAD");
  });
  it("an all-space field is the empty string", () => {
    expect(decodeText(ascii("         "), 0, 9)).toBe("");
  });
  it("low-values are never exposed (become padding, then trimmed)", () => {
    const buf = Buffer.concat([ascii("AB"), hex("0000")]);
    const v = decodeText(buf, 0, 4);
    expect(v).toBe("AB");
    expect(v.includes("\u0000")).toBe(false);
    expect(decodeText(Buffer.concat([ascii("A"), hex("00"), ascii("B")]), 0, 3)).toBe("A B");
  });
  it("plants ACCTMSTR#12: a 25-byte MEMO followed by low-value FILLER does not leak U+0000", () => {
    const rec = acctRecord({
      id: "0000000051",
      name: "LOWVALUE FILLER CO",
      balance: "0000006000{",
      taxId: "900000051",
      memo: "AUTOPAY ENROLLED VIA BRCH",
      fillerHex: "00000000",
    });
    expect(rec.subarray(96, 100).equals(hex("00000000"))).toBe(true);
    const memo = decodeText(rec, 71, 25);
    expect(memo).toBe("AUTOPAY ENROLLED VIA BRCH");
    expect(memo.length).toBe(25);
    expect(JSON.stringify(decodeRecord(ACCT, rec, 0), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(
      "\\u0000",
    );
  });
  it("other non-printable bytes are shown as ?", () => {
    expect(decodeText(Buffer.concat([ascii("A"), hex("07"), ascii("B")]), 0, 3)).toBe("A?B");
  });
});

describe("decodeRecord ACCTMSTR", () => {
  it("plants ACCTMSTR#3 decodes to raw typed values", () => {
    expect(decodeRecord(ACCT, REC3, 0)).toEqual({
      account_id: "0000000042",
      name: "HARTLEY MERCANTILE LTD",
      status: "A",
      open_date: "1998-03-15",
      balance_minor: -123456n,
      credit_limit_minor: 250000n,
      rate_thousandths: 35n,
      tax_id: "900421234",
      memo: "OVERDRAWN - REVIEW",
    });
  });

  it("never exposes FILLER", () => {
    expect(Object.keys(decodeRecord(ACCT, REC3, 0))).not.toContain("FILLER");
    expect(Object.keys(decodeRecord(ACCT, REC3, 0))).toHaveLength(9);
  });

  it("plants ACCTMSTR#7: OPEN-DATE 000000 ⇒ null; ACCTMSTR#10 raw status X is returned raw (bridge maps it)", () => {
    const never = acctRecord({
      id: "0000000046",
      name: "NEVER OPENED ACCOUNT",
      status: "S",
      open: "000000",
      balance: "0000000000{",
      taxId: "900000046",
    });
    expect(decodeRecord(ACCT, never, 0)["open_date"]).toBeNull();
    const x = acctRecord({ id: "0000000049", name: "CLOSED VIA X CODE CO", status: "X", balance: "0000000500{", taxId: "900000049" });
    expect(decodeRecord(ACCT, x, 0)["status"]).toBe("X");
  });

  it("plants ACCTMSTR#8: RATE 0057 ⇒ 57 thousandths, BALANCE 9876543", () => {
    const r8 = acctRecord({
      id: "0000000047",
      name: "ROUNDING TRAP INDUSTRIES",
      open: "050101",
      balance: "0000987654C",
      rate: "0057",
      taxId: "900000047",
    });
    expect(decodeRecord(ACCT, r8, 0)).toMatchObject({ open_date: "2005-01-01", balance_minor: 9876543n, rate_thousandths: 57n });
  });

  it("decodes the second record of a buffer at its record offset", () => {
    const pivot49 = acctRecord({ id: "0000000044", name: "PIVOT FORTY NINE CO", open: "490615", balance: "0000001000{", taxId: "900000044" });
    const buf = Buffer.concat([REC3, pivot49]);
    expect(decodeRecord(ACCT, buf, 100)).toMatchObject({ account_id: "0000000044", open_date: "2049-06-15", balance_minor: 10000n });
  });

  it("refuses a partial record (plants truncated tail: 37 bytes)", () => {
    const tail = ascii("0000001040TRUNCATED TAIL RECORD    A9");
    expect(tail.length).toBe(37);
    expect(() => decodeRecord(ACCT, Buffer.concat([REC3, tail]), 100)).toThrow(LayoutMismatch);
  });

  it("a defective money byte is a named error", () => {
    const bad = acctRecord({ id: "0000000042", name: "X", balance: "0000012345S", taxId: "900421234" });
    expect(() => decodeRecord(ACCT, bad, 0)).toThrow(BadSign);
  });
});

describe("decodeRecord TRANS", () => {
  it("plants TRANS#6001", () => {
    const t = tranRecord({
      tranId: "1000006001",
      acctId: "0000000050",
      date: "240131",
      type: "D",
      amount: "00001234E",
      status: "O",
      desc: "AGING TRAP 31ST DEBIT",
    });
    expect(decodeRecord(TRANS, t, 0)).toEqual({
      tran_id: "1000006001",
      account_id: "0000000050",
      date: "2024-01-31",
      type: "D",
      amount_minor: 12345n,
      status: "O",
      desc: "AGING TRAP 31ST DEBIT",
    });
  });

  it("TRAN-DATE has no never value: 000000 is a BadDate", () => {
    const t = tranRecord({
      tranId: "1000000001",
      acctId: "0000000050",
      date: "000000",
      type: "D",
      amount: "00000100{",
      status: "O",
      desc: "X",
    });
    expect(() => decodeRecord(TRANS, t, 0)).toThrow(BadDate);
  });
});
