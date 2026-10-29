// src/mcpkit/mask.ts — tax-id masking applied at the shared output boundary, before cap measurement, audit hashing and
// exposure (LEGACY-BEHAVIOUR §5.9). Masking is idempotent, so applying it twice is harmless.

export const TAX_ID_KEY = "tax_id";

/** `***-**-` + last four characters; a blank tax id stays blank. */
export function maskTaxId(raw: string): string {
  const trimmed = raw.replace(/ +$/, "");
  if (trimmed.trim() === "") return "";
  return `***-**-${trimmed.slice(-4)}`;
}

/** Return a deep copy of `value` in which every string under a `tax_id` key is masked. */
export function maskDeep<T>(value: T): T {
  return maskAny(value) as T;
}

function maskAny(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskAny);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = k === TAX_ID_KEY && typeof v === "string" ? maskTaxId(v) : maskAny(v);
    }
    return out;
  }
  return value;
}
