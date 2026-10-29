// src/fixedwidth/dates.ts — YYMMDD decoding with century pivot 50, Gregorian calendar validation, the 30E/360 day count and
// the aging buckets (LEGACY-BEHAVIOUR §5.6, §8).
import { BadDate } from "./errors.ts";
import { decodeDigits } from "./money.ts";

export const DEFAULT_PIVOT = 50;

export type AgingBucket = "0" | "1-30" | "31-60" | "61-90" | ">90";
export const AGING_BUCKETS: readonly AgingBucket[] = ["0", "1-30", "31-60", "61-90", ">90"];

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

export function isValidYmd(y: number, m: number, d: number): boolean {
  return Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d) && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

function isoOf(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Six YYMMDD digit bytes ⇒ ISO date. YY below the pivot ⇒ 20YY, otherwise 19YY. `000000` ⇒ null ("never").
 * A non-calendar date throws BadDate.
 */
export function decodeYYMMDD(buf: Buffer, off: number, pivot: number = DEFAULT_PIVOT): string | null {
  const raw = decodeDigits(buf, off, 6);
  if (raw === "000000") return null;
  const yy = Number(raw.slice(0, 2));
  const m = Number(raw.slice(2, 4));
  const d = Number(raw.slice(4, 6));
  const y = yy < pivot ? 2000 + yy : 1900 + yy;
  if (!isValidYmd(y, m, d)) throw new BadDate(`YYMMDD ${raw} at offset ${off} is not a calendar date`);
  return isoOf(y, m, d);
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseIso(s: string): { y: number; m: number; d: number } | null {
  const match = ISO_RE.exec(s);
  if (match === null) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  return isValidYmd(y, m, d) ? { y, m, d } : null;
}

/** A real calendar date written as YYYY-MM-DD. */
export function isIsoDate(s: string): boolean {
  return parseIso(s) !== null;
}

/** 30E/360 without February adjustment: 360×(Y2−Y1) + 30×(M2−M1) + min(D2,30) − min(D1,30); 1 = from, 2 = to. */
export function days30E360(fromIso: string, toIso: string): number {
  const a = parseIso(fromIso);
  const b = parseIso(toIso);
  if (a === null) throw new BadDate(`not an ISO calendar date: ${fromIso}`);
  if (b === null) throw new BadDate(`not an ISO calendar date: ${toIso}`);
  return 360 * (b.y - a.y) + 30 * (b.m - a.m) + Math.min(b.d, 30) - Math.min(a.d, 30);
}

/** Bucket of a non-negative 30E/360 day count. */
export function agingBucket(days: number): AgingBucket {
  if (!Number.isInteger(days) || days < 0) throw new BadDate(`aging day count must be a non-negative integer, got ${days}`);
  if (days === 0) return "0";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return ">90";
}
