// src/mcpkit/cap.ts — the 65,536-byte cap on a complete tool result. The caller's `build` returns the whole result for a
// given prefix of rows (structured content, text summary, markers, cursor); it is masked first, then measured as UTF-8
// JSON. Rows are dropped whole from the end, never mid-JSON; if no prefix (not even zero rows) fits ⇒ ToolError over_cap.
import { ToolError } from "./errors.ts";
import { maskDeep } from "./mask.ts";

export const CAP_BYTES = 65536;

export type FitOptions = {
  /** Cap in bytes (tests may lower it); defaults to CAP_BYTES. */
  cap?: number;
  /** Masking applied before measurement; defaults to maskDeep. */
  mask?: (value: object) => object;
};

export type FitResult = { payload: object; kept: number; truncated: boolean; bytes: number };

/** UTF-8 byte length of the JSON serialisation (payloads must hold numbers, not bigints). */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Largest prefix of `rows` whose masked, built result fits the cap. `build(prefix)` must produce the complete result for
 * exactly that prefix; it can tell truncation from `prefix.length < rows.length`.
 */
export function fitRows<T>(build: (rows: T[]) => object, rows: T[], opts: FitOptions = {}): FitResult {
  const cap = opts.cap ?? CAP_BYTES;
  const mask = opts.mask ?? ((v: object) => maskDeep(v));
  const attempt = (k: number): { payload: object; bytes: number } => {
    const payload = mask(build(rows.slice(0, k)));
    return { payload, bytes: jsonBytes(payload) };
  };

  const all = attempt(rows.length);
  if (all.bytes <= cap) return { payload: all.payload, kept: rows.length, truncated: false, bytes: all.bytes };

  // Binary search for the largest k in [0, rows.length) that fits; size grows with k.
  let lo = 0;
  let hi = rows.length - 1;
  let best: { k: number; payload: object; bytes: number } | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = attempt(mid);
    if (r.bytes <= cap) {
      best = { k: mid, ...r };
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best === null) throw new ToolError("over_cap", `result exceeds the ${cap}-byte cap even with zero rows`);
  return { payload: best.payload, kept: best.k, truncated: true, bytes: best.bytes };
}
