// src/fixedwidth/money.ts — numeric field decoding (zoned with trailing overpunch, COMP-3 packed, digit strings) and the
// monthly-interest rule. Money is integer minor units held in BigInt; no floating point anywhere (LEGACY-BEHAVIOUR §5).
import { BadDigit, BadPacked, BadSign, Overflow } from "./errors.ts";

/** Trailing overpunch: index in the string = the digit carried by the byte. */
const POSITIVE_OVERPUNCH = "{ABCDEFGHI";
const NEGATIVE_OVERPUNCH = "}JKLMNOPQR";

/** Divisor of the monthly-interest rule: 12 months × 1000 (rate is in thousandths). */
export const INTEREST_DIVISOR = 12000n;

function checkRange(buf: Buffer, off: number, len: number): void {
  if (!Number.isInteger(off) || !Number.isInteger(len) || off < 0 || len < 1 || off + len > buf.length) {
    throw new BadDigit(`field [${off}, +${len}) lies outside a ${buf.length}-byte buffer`);
  }
}

function isDigitByte(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

function byteAt(buf: Buffer, i: number): number {
  const b = buf[i];
  if (b === undefined) throw new BadDigit(`no byte at offset ${i}`);
  return b;
}

/** Unsigned display digits returned as the exact digit string (leading zeros kept), e.g. account keys and YYMMDD. */
export function decodeDigits(buf: Buffer, off: number, len: number): string {
  checkRange(buf, off, len);
  let out = "";
  for (let i = off; i < off + len; i++) {
    const b = byteAt(buf, i);
    if (!isDigitByte(b)) throw new BadDigit(`non-digit byte 0x${b.toString(16).padStart(2, "0")} at offset ${i}`);
    out += String.fromCharCode(b);
  }
  return out;
}

/**
 * Zoned decimal. Every byte but the last is a digit; for a signed field the last byte is a digit (read as positive) or an
 * overpunch character ({ A-I positive, } J-R negative). The implied decimal point is not stored, so the integer read is the
 * value in the field's minor units.
 */
export function decodeZoned(buf: Buffer, off: number, len: number, signed: boolean): bigint {
  checkRange(buf, off, len);
  let digits = len > 1 ? decodeDigits(buf, off, len - 1) : "";
  const lastAt = off + len - 1;
  const last = byteAt(buf, lastAt);
  let negative = false;
  if (isDigitByte(last)) {
    digits += String.fromCharCode(last);
  } else if (!signed) {
    throw new BadDigit(`unsigned field has non-digit last byte 0x${last.toString(16).padStart(2, "0")} at offset ${lastAt}`);
  } else {
    const ch = String.fromCharCode(last);
    const pos = POSITIVE_OVERPUNCH.indexOf(ch);
    const neg = NEGATIVE_OVERPUNCH.indexOf(ch);
    if (pos >= 0) {
      digits += String(pos);
    } else if (neg >= 0) {
      digits += String(neg);
      negative = true;
    } else {
      throw new BadSign(`invalid overpunch byte 0x${last.toString(16).padStart(2, "0")} at offset ${lastAt}`);
    }
  }
  const magnitude = BigInt(digits);
  return negative ? -magnitude : magnitude;
}

/**
 * COMP-3 packed decimal: 2×len nibbles, all digit nibbles (0-9) except the final sign nibble (C or F positive, D negative).
 * For CREDIT-LIMIT S9(7)V99 that is 5 bytes = 9 digits + sign.
 */
export function decodePacked(buf: Buffer, off: number, len: number): bigint {
  checkRange(buf, off, len);
  let digits = "";
  let sign = -1;
  for (let i = 0; i < len; i++) {
    const b = byteAt(buf, off + i);
    const hi = b >> 4;
    const lo = b & 0x0f;
    if (hi > 9) throw new BadPacked(`digit nibble 0x${hi.toString(16)} at offset ${off + i}`);
    digits += String(hi);
    if (i < len - 1) {
      if (lo > 9) throw new BadPacked(`digit nibble 0x${lo.toString(16)} at offset ${off + i}`);
      digits += String(lo);
    } else {
      sign = lo;
    }
  }
  const magnitude = BigInt(digits);
  if (sign === 0x0c || sign === 0x0f) return magnitude;
  if (sign === 0x0d) return -magnitude;
  throw new BadPacked(`invalid sign nibble 0x${sign.toString(16)} at offset ${off + len - 1}`);
}

/** Range-check a BigInt minor-unit value into a JSON-safe integer. */
export function toSafeMinor(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Overflow(`value ${v.toString()} is outside the safe integer range`);
  }
  return Number(v);
}

/** monthly_interest_minor = trunc(balance_minor × rate_thousandths / 12000); BigInt division truncates toward zero. */
export function monthlyInterestMinor(balanceMinor: bigint, rateThousandths: bigint): bigint {
  return (balanceMinor * rateThousandths) / INTEREST_DIVISOR;
}
