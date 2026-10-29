// src/fixedwidth/decode.ts — text decoding (declared trailing padding trimmed, low-values never exposed) and whole-record
// decoding driven by a validated Layout. Values are raw-but-typed: status codes, tax ids and free text are returned as stored
// (trimmed); effective status, masking and untrusted_text wrapping belong to the bridge.
import { BadDate, LayoutMismatch } from "./errors.ts";
import { DEFAULT_PIVOT, decodeYYMMDD } from "./dates.ts";
import type { Layout } from "./layout.ts";
import { decodeDigits, decodePacked, decodeZoned } from "./money.ts";

export type DecodedValue = string | bigint | null;
export type DecodedRecord = Record<string, DecodedValue>;

/**
 * ASCII text field. Low-values (0x00) become spaces, other non-printable bytes become "?" (as the legacy program prints
 * them), then only trailing spaces are trimmed. Leading and internal spaces, including double spaces, are kept; no U+0000
 * can ever be returned.
 */
export function decodeText(buf: Buffer, off: number, len: number): string {
  if (!Number.isInteger(off) || !Number.isInteger(len) || off < 0 || len < 0 || off + len > buf.length) {
    throw new LayoutMismatch(`text field [${off}, +${len}) lies outside a ${buf.length}-byte buffer`);
  }
  let out = "";
  for (let i = off; i < off + len; i++) {
    const b = buf[i] ?? 0x20;
    if (b === 0x00) out += " ";
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += "?";
  }
  return out.replace(/ +$/, "");
}

/**
 * Decode one record starting at recordOffset into { property: value } for every exposed field:
 * alnum ⇒ trimmed string; unsigned zoned with scale 0 (keys) ⇒ digit string with leading zeros; other zoned and packed ⇒
 * bigint in minor units (RATE ⇒ thousandths); date_yymmdd ⇒ ISO string, or null for the layout's "never" value.
 * Throws a FixedWidthError (BadDigit / BadSign / BadPacked / BadDate / LayoutMismatch) on a defective record.
 */
export function decodeRecord(layout: Layout, buf: Buffer, recordOffset: number): DecodedRecord {
  if (!Number.isInteger(recordOffset) || recordOffset < 0 || recordOffset + layout.recordLength > buf.length) {
    throw new LayoutMismatch(
      `${layout.record} record at ${recordOffset} needs ${layout.recordLength} bytes; buffer has ${buf.length}`,
    );
  }
  const out: DecodedRecord = {};
  for (const f of layout.fields) {
    if (!f.exposed || f.property === null) continue;
    const at = recordOffset + f.offset;
    switch (f.type) {
      case "alnum":
        out[f.property] = decodeText(buf, at, f.length);
        break;
      case "zoned":
        out[f.property] = f.scale === 0 && !f.signed ? decodeDigits(buf, at, f.length) : decodeZoned(buf, at, f.length, f.signed);
        break;
      case "packed":
        out[f.property] = decodePacked(buf, at, f.length);
        break;
      case "date_yymmdd": {
        const iso = decodeYYMMDD(buf, at, f.dateWindow?.pivot ?? DEFAULT_PIVOT);
        if (iso === null && f.dateWindow?.never !== "000000") {
          throw new BadDate(`${layout.record}.${f.name} at ${at}: 000000 is not allowed in this field`);
        }
        out[f.property] = iso;
        break;
      }
      case "lowvalues":
        break;
    }
  }
  return out;
}
