// tests/unit/fixedwidth/dates.test.ts — pivot 49/50, 000000 ⇒ null, calendar validation (31 April, Feb 29 leap rules),
// 30E/360 at the 31st and February end, and bucket edges 0/30/31/60/61/90/91.
import { describe, expect, it } from "vitest";
import { BadDate, BadDigit } from "../../../src/fixedwidth/errors.ts";
import { agingBucket, days30E360, decodeYYMMDD, isIsoDate } from "../../../src/fixedwidth/dates.ts";
import { ascii } from "../../helpers/fixedwidthBytes.ts";

const yymmdd = (s: string): string | null => decodeYYMMDD(ascii(s), 0);

describe("decodeYYMMDD pivot 50", () => {
  it("plants ACCTMSTR#5: 490615 ⇒ 2049-06-15", () => {
    expect(yymmdd("490615")).toBe("2049-06-15");
  });
  it("plants ACCTMSTR#6: 500615 ⇒ 1950-06-15", () => {
    expect(yymmdd("500615")).toBe("1950-06-15");
  });
  it("plants ACCTMSTR#7: 000000 ⇒ null (never opened)", () => {
    expect(yymmdd("000000")).toBeNull();
  });
  it("plants defaults: 980315 ⇒ 1998-03-15; 000101 ⇒ 2000-01-01; 991231 ⇒ 1999-12-31", () => {
    expect(yymmdd("980315")).toBe("1998-03-15");
    expect(yymmdd("000101")).toBe("2000-01-01");
    expect(yymmdd("991231")).toBe("1999-12-31");
  });
  it("decodes at an offset (TRAN-DATE at 20)", () => {
    const buf = ascii("10000060010000000050240131D");
    expect(decodeYYMMDD(buf, 20)).toBe("2024-01-31");
  });
  it("rejects non-digit bytes", () => {
    expect(() => yymmdd("24013A")).toThrow(BadDigit);
  });
});

describe("calendar validation", () => {
  it("no 31 April", () => {
    expect(() => yymmdd("240431")).toThrow(BadDate);
    expect(isIsoDate("2024-04-31")).toBe(false);
    expect(isIsoDate("2024-04-30")).toBe(true);
  });
  it("29 February only in leap years (Gregorian rule)", () => {
    expect(yymmdd("240229")).toBe("2024-02-29");
    expect(() => yymmdd("230229")).toThrow(BadDate);
    expect(yymmdd("000229")).toBe("2000-02-29"); // divisible by 400
    expect(isIsoDate("1900-02-29")).toBe(false); // divisible by 100, not 400
    expect(isIsoDate("2100-02-29")).toBe(false);
    expect(isIsoDate("2000-02-29")).toBe(true);
    expect(isIsoDate("2023-02-29")).toBe(false);
  });
  it("rejects month 00/13 and day 00/32", () => {
    expect(() => yymmdd("240001")).toThrow(BadDate);
    expect(() => yymmdd("241301")).toThrow(BadDate);
    expect(() => yymmdd("240100")).toThrow(BadDate);
    expect(() => yymmdd("240132")).toThrow(BadDate);
  });
  it("isIsoDate needs the exact YYYY-MM-DD shape", () => {
    expect(isIsoDate("2024-4-30")).toBe(false);
    expect(isIsoDate("20240430")).toBe(false);
    expect(isIsoDate("2024-04-30T00:00:00Z")).toBe(false);
    expect(isIsoDate(" 2024-04-30")).toBe(false);
  });
});

describe("days30E360", () => {
  it("plants TRANS#6001: 2024-01-31 aged at 2024-03-01 = 31 (calendar days would be 30)", () => {
    expect(days30E360("2024-01-31", "2024-03-01")).toBe(31);
    expect(agingBucket(days30E360("2024-01-31", "2024-03-01"))).toBe("31-60");
  });
  it("plants TRANS#6002: 2023-02-28 aged at 2023-03-30 = 32 (no February adjustment)", () => {
    expect(days30E360("2023-02-28", "2023-03-30")).toBe(32);
    expect(agingBucket(32)).toBe("31-60");
  });
  it("plants TRANS#6002 at 2024-03-01 = 363 ⇒ >90", () => {
    expect(days30E360("2023-02-28", "2024-03-01")).toBe(363);
    expect(agingBucket(363)).toBe(">90");
  });
  it("31st to 31st counts whole months; same day is 0", () => {
    expect(days30E360("2024-01-31", "2024-03-31")).toBe(60);
    expect(days30E360("2024-03-01", "2024-03-01")).toBe(0);
    expect(days30E360("2024-01-30", "2024-01-31")).toBe(0);
  });
  it("rejects non-calendar dates", () => {
    expect(() => days30E360("2024-04-31", "2024-05-01")).toThrow(BadDate);
  });
});

describe("agingBucket edges", () => {
  it.each([
    [0, "0"],
    [1, "1-30"],
    [30, "1-30"],
    [31, "31-60"],
    [60, "31-60"],
    [61, "61-90"],
    [90, "61-90"],
    [91, ">90"],
  ] as const)("%i days ⇒ %s", (days, bucket) => {
    expect(agingBucket(days)).toBe(bucket);
  });
  it("rejects negative or fractional day counts", () => {
    expect(() => agingBucket(-1)).toThrow(BadDate);
    expect(() => agingBucket(1.5)).toThrow(BadDate);
  });
});
