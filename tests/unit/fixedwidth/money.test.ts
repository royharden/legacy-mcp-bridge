// tests/unit/fixedwidth/money.test.ts — zoned overpunch (both signs), implied decimals, COMP-3 and sign-nibble validation,
// safe-integer range check and the truncating monthly-interest rule. Literals from fixtures/plants.json where they exist.
import { describe, expect, it } from "vitest";
import { BadDigit, BadPacked, BadSign, Overflow } from "../../../src/fixedwidth/errors.ts";
import {
  decodeDigits,
  decodePacked,
  decodeZoned,
  monthlyInterestMinor,
  toSafeMinor,
} from "../../../src/fixedwidth/money.ts";
import { ascii, hex } from "../../helpers/fixedwidthBytes.ts";

const zoned = (s: string, signed = true): bigint => decodeZoned(ascii(s), 0, s.length, signed);

describe("decodeZoned trailing overpunch", () => {
  const positive = ["{", "A", "B", "C", "D", "E", "F", "G", "H", "I"];
  const negative = ["}", "J", "K", "L", "M", "N", "O", "P", "Q", "R"];

  it.each(positive.map((c, d) => [c, d] as const))("positive overpunch %s carries digit %i", (c, d) => {
    expect(zoned(`12${c}`)).toBe(BigInt(120 + d));
  });

  it.each(negative.map((c, d) => [c, d] as const))("negative overpunch %s carries digit %i", (c, d) => {
    expect(zoned(`12${c}`)).toBe(-BigInt(120 + d));
  });

  it("plants ACCTMSTR#3 BALANCE 0000012345O is -123456 minor (-1,234.56)", () => {
    expect(zoned("0000012345O")).toBe(-123456n);
  });

  it("plants ACCTMSTR#8 BALANCE 0000987654C is 9876543 minor (implied 2 decimals)", () => {
    expect(zoned("0000987654C")).toBe(9876543n);
  });

  it("plants TRANS#6001/#6002 AMOUNT S9(7)V99: 00001234E = 12345, 00000678I = 6789", () => {
    expect(zoned("00001234E")).toBe(12345n);
    expect(zoned("00000678I")).toBe(6789n);
  });

  it("negative zero overpunch is zero", () => {
    expect(zoned("0000000000}")).toBe(0n);
  });

  it("a plain trailing digit in a signed field reads as positive", () => {
    expect(zoned("0000001234")).toBe(1234n);
  });

  it("decodes at a non-zero offset without reading neighbours", () => {
    const buf = ascii("XX00001234EYY");
    expect(decodeZoned(buf, 2, 9, true)).toBe(12345n);
  });

  it("unsigned 9V999 RATE digits give thousandths: 0035 = 35, 0057 = 57", () => {
    expect(zoned("0035", false)).toBe(35n);
    expect(zoned("0057", false)).toBe(57n);
  });

  it("rejects an overpunch byte in an unsigned field (BadDigit)", () => {
    expect(() => zoned("003E", false)).toThrow(BadDigit);
  });

  it("rejects an invalid overpunch byte in a signed field (BadSign)", () => {
    expect(() => zoned("0012S")).toThrow(BadSign);
    expect(() => zoned("0012 ")).toThrow(BadSign);
  });

  it("rejects a non-digit before the last byte (BadDigit)", () => {
    expect(() => zoned("00 2345E")).toThrow(BadDigit);
  });

  it("rejects a field outside the buffer", () => {
    expect(() => decodeZoned(ascii("123"), 1, 3, true)).toThrow(BadDigit);
  });
});

describe("decodeDigits", () => {
  it("keeps leading zeros of keys", () => {
    expect(decodeDigits(ascii("0000000042"), 0, 10)).toBe("0000000042");
  });
  it("rejects non-digits", () => {
    expect(() => decodeDigits(ascii("00000000A2"), 0, 10)).toThrow(BadDigit);
  });
});

describe("decodePacked (COMP-3)", () => {
  it("plants ACCTMSTR#3 CREDIT-LIMIT 00 02 50 00 0C = +250000 minor (2,500.00)", () => {
    expect(decodePacked(hex("000250000C"), 0, 5)).toBe(250000n);
  });
  it("plants defaults CREDIT-LIMIT 000100000C = 100000", () => {
    expect(decodePacked(hex("000100000C"), 0, 5)).toBe(100000n);
  });
  it("sign nibble F is positive, D is negative", () => {
    expect(decodePacked(hex("000250000F"), 0, 5)).toBe(250000n);
    expect(decodePacked(hex("000250000D"), 0, 5)).toBe(-250000n);
    expect(decodePacked(hex("123456789D"), 0, 5)).toBe(-123456789n);
  });
  it("rejects other sign nibbles (A, B, E, 0)", () => {
    for (const h of ["000250000A", "000250000B", "000250000E", "0002500000"]) {
      expect(() => decodePacked(hex(h), 0, 5)).toThrow(BadPacked);
    }
  });
  it("rejects a digit nibble above 9 in either half-byte", () => {
    expect(() => decodePacked(hex("0A0250000C"), 0, 5)).toThrow(BadPacked);
    expect(() => decodePacked(hex("A00250000C"), 0, 5)).toThrow(BadPacked);
    expect(() => decodePacked(hex("00025000FC"), 0, 5)).toThrow(BadPacked);
  });
  it("decodes at an offset", () => {
    expect(decodePacked(hex("FFFF000250000CFF"), 2, 5)).toBe(250000n);
  });
});

describe("toSafeMinor", () => {
  it("passes safe integers through as numbers", () => {
    expect(toSafeMinor(-123456n)).toBe(-123456);
    expect(toSafeMinor(9007199254740991n)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("throws Overflow beyond the safe range", () => {
    expect(() => toSafeMinor(9007199254740992n)).toThrow(Overflow);
    expect(() => toSafeMinor(-9007199254740992n)).toThrow(Overflow);
  });
});

describe("monthlyInterestMinor = trunc(balance × rate / 12000)", () => {
  it("plants interest trap: 9876543 × 57 ⇒ 46913 (rounding would give 46914)", () => {
    expect(monthlyInterestMinor(9876543n, 57n)).toBe(46913n);
    const roundHalfUp = (9876543n * 57n * 2n + 12000n) / 24000n;
    expect(roundHalfUp).toBe(46914n);
  });
  it("plants ACCTMSTR#9: 30000 × 35 = 87.5 ⇒ 87, not 88", () => {
    expect(monthlyInterestMinor(30000n, 35n)).toBe(87n);
  });
  it("truncates toward zero for negative balances: -123456 × 35 ⇒ -360 (floor would be -361)", () => {
    expect(monthlyInterestMinor(-123456n, 35n)).toBe(-360n);
  });
  it("exact division and zero balance", () => {
    expect(monthlyInterestMinor(60000n, 35n)).toBe(175n);
    expect(monthlyInterestMinor(750000n, 100n)).toBe(6250n);
    expect(monthlyInterestMinor(0n, 35n)).toBe(0n);
  });
});
