// src/fixedwidth/copybook.ts — parser for the copybook subset of LEGACY-BEHAVIOUR §2 (01 record + 05 elementary items with
// X / numeric PICs and optional COMP-3) and the check that a layout JSON agrees with its copybook. Anything outside the
// subset is a named UnsupportedClause, never silently ignored.
import { LayoutMismatch, UnsupportedClause } from "./errors.ts";
import type { Layout, LayoutField } from "./layout.ts";

export type CopybookKind = "alnum" | "zoned" | "packed";

export type CopybookField = {
  name: string;
  offset: number;
  length: number;
  kind: CopybookKind;
  /** Numeric digits (0 for alnum). */
  digits: number;
  /** Implied decimal places (0 for alnum). */
  scale: number;
  signed: boolean;
  /** PIC text as written, with " COMP-3" appended for packed items (matches layouts JSON copybook.pic). */
  pic: string;
  /** One-based physical line number in the copybook. */
  line: number;
};

/** Clauses that are recognised by name so the error says exactly what was rejected. */
const NAMED_CLAUSES = [
  "REDEFINES",
  "OCCURS",
  "COPY",
  "VALUE",
  "VALUES",
  "SIGN",
  "SEPARATE",
  "LEADING",
  "TRAILING",
  "COMP",
  "COMP-1",
  "COMP-2",
  "COMP-4",
  "COMP-5",
  "BINARY",
  "PACKED-DECIMAL",
  "USAGE",
  "JUSTIFIED",
  "JUST",
  "BLANK",
  "SYNC",
  "SYNCHRONIZED",
  "INDEXED",
  "RENAMES",
  "DEPENDING",
] as const;

const NAME_RE = /^[A-Z][A-Z0-9-]*$/;
const ALNUM_PIC_RE = /^X(?:\((\d+)\))?$/;
const NUMERIC_PIC_RE = /^(S?)(9\((\d+)\)|9+)(?:V(9\((\d+)\)|9+))?$/;

function unsupported(clause: string, line: number, detail: string): never {
  throw new UnsupportedClause(clause, `copybook line ${line}: unsupported ${clause}: ${detail}`);
}

/** Count of digits in a "9(n)" or "9…" group; repeat-count form uses the captured n. */
function groupDigits(group: string, repeat: string | undefined, line: number): number {
  const n = repeat !== undefined ? Number(repeat) : group.length;
  if (!Number.isInteger(n) || n < 1) unsupported("PIC", line, `bad digit count in ${group}`);
  return n;
}

function parsePic(
  pic: string,
  comp3: boolean,
  line: number,
): { kind: CopybookKind; length: number; digits: number; scale: number; signed: boolean } {
  const alnum = ALNUM_PIC_RE.exec(pic);
  if (alnum !== null) {
    if (comp3) unsupported("COMP-3", line, `COMP-3 on alphanumeric PIC ${pic}`);
    const n = alnum[1] !== undefined ? Number(alnum[1]) : 1;
    if (!Number.isInteger(n) || n < 1) unsupported("PIC", line, `bad length in ${pic}`);
    return { kind: "alnum", length: n, digits: 0, scale: 0, signed: false };
  }
  const num = NUMERIC_PIC_RE.exec(pic);
  if (num === null) unsupported("PIC", line, `PIC ${pic} is outside the subset`);
  const signed = num[1] === "S";
  const intGroup = num[2] ?? "";
  const intDigits = groupDigits(intGroup, num[3], line);
  const fracGroup = num[4];
  const scale = fracGroup === undefined ? 0 : groupDigits(fracGroup, num[5], line);
  const digits = intDigits + scale;
  if (comp3) return { kind: "packed", length: Math.floor(digits / 2) + 1, digits, scale, signed };
  return { kind: "zoned", length: digits, digits, scale, signed };
}

/** Parse copybook text into elementary fields with zero-based offsets. */
export function parseCopybook(text: string): CopybookField[] {
  const fields: CopybookField[] = [];
  let sawRecord = false;
  let offset = 0;
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i] ?? "";
    if (raw.trim() === "") continue;
    if (raw.length >= 7 && raw[6] === "*") continue;
    if (raw.slice(0, 6).trim() !== "") unsupported("SEQUENCE-AREA", lineNo, "columns 1-6 must be blank");
    if (raw[6] !== undefined && raw[6] !== " ") unsupported("INDICATOR", lineNo, `indicator column holds '${raw[6]}'`);

    const stmt = raw.slice(7).trim();
    if (!stmt.endsWith(".")) unsupported("SYNTAX", lineNo, "statement must end with a period");
    const tokens = stmt.slice(0, -1).trim().split(/\s+/);
    const upper = tokens.map((t) => t.toUpperCase());

    // Named clause anywhere in the statement (COPY is a statement of its own).
    for (const t of upper) {
      const named = NAMED_CLAUSES.find((c) => c === t);
      if (named !== undefined) unsupported(named, lineNo, stmt);
    }

    const level = tokens[0] ?? "";
    if (level === "01") {
      if (sawRecord) unsupported("LEVEL 01", lineNo, "only one 01 record per copybook");
      if (tokens.length !== 2 || !NAME_RE.test(tokens[1] ?? "")) unsupported("SYNTAX", lineNo, stmt);
      sawRecord = true;
      continue;
    }
    if (level !== "05") unsupported(`LEVEL ${level}`, lineNo, "only levels 01 and 05 are supported");
    if (!sawRecord) unsupported("SYNTAX", lineNo, "05 item before the 01 record");

    const name = tokens[1] ?? "";
    if (!NAME_RE.test(name)) unsupported("SYNTAX", lineNo, `bad field name '${name}'`);
    if (tokens.length === 2) unsupported("GROUP", lineNo, `group item ${name} (no PIC) is outside the subset`);
    if (upper[2] !== "PIC") unsupported(tokens[2] ?? "SYNTAX", lineNo, stmt);
    const pic = tokens[3];
    if (pic === undefined) unsupported("PIC", lineNo, "missing PIC string");
    let comp3 = false;
    if (tokens.length === 5) {
      if (upper[4] !== "COMP-3") unsupported(tokens[4] ?? "SYNTAX", lineNo, stmt);
      comp3 = true;
    } else if (tokens.length !== 4) {
      unsupported(tokens[4] ?? "SYNTAX", lineNo, stmt);
    }

    const parsed = parsePic(pic, comp3, lineNo);
    fields.push({ name, offset, ...parsed, pic: comp3 ? `${pic} COMP-3` : pic, line: lineNo });
    offset += parsed.length;
  }

  if (!sawRecord) unsupported("SYNTAX", 0, "no 01 record");
  if (fields.length === 0) unsupported("SYNTAX", 0, "record has no elementary items");
  return fields;
}

/** Total record length of parsed copybook fields. */
export function copybookRecordLength(fields: readonly CopybookField[]): number {
  return fields.reduce((n, f) => n + f.length, 0);
}

function expectedKind(f: LayoutField): CopybookKind {
  switch (f.type) {
    case "alnum":
    case "lowvalues":
      return "alnum";
    case "zoned":
    case "date_yymmdd":
      return "zoned";
    case "packed":
      return "packed";
  }
}

/** Throws LayoutMismatch unless every layout field agrees with the copybook item at the same position. */
export function checkLayoutAgainstCopybook(layout: Layout, fields: readonly CopybookField[]): void {
  const where = layout.record;
  if (layout.fields.length !== fields.length) {
    throw new LayoutMismatch(`${where}: layout has ${layout.fields.length} fields, copybook has ${fields.length}`);
  }
  const total = copybookRecordLength(fields);
  if (total !== layout.recordLength) {
    throw new LayoutMismatch(`${where}: copybook length ${total} != layout recordLength ${layout.recordLength}`);
  }
  layout.fields.forEach((lf, i) => {
    const cf = fields[i];
    if (cf === undefined) throw new LayoutMismatch(`${where}: missing copybook field ${i}`);
    const diffs: string[] = [];
    if (lf.name !== cf.name) diffs.push(`name ${lf.name} != ${cf.name}`);
    if (lf.offset !== cf.offset) diffs.push(`offset ${lf.offset} != ${cf.offset}`);
    if (lf.length !== cf.length) diffs.push(`length ${lf.length} != ${cf.length}`);
    if (expectedKind(lf) !== cf.kind) diffs.push(`type ${lf.type} incompatible with ${cf.kind}`);
    if (lf.signed !== cf.signed) diffs.push(`signed ${String(lf.signed)} != ${String(cf.signed)}`);
    if (cf.kind !== "alnum") {
      const digits = lf.type === "date_yymmdd" ? 6 : lf.digits;
      if (digits !== cf.digits) diffs.push(`digits ${String(digits)} != ${cf.digits}`);
      if (lf.scale !== cf.scale) diffs.push(`scale ${lf.scale} != ${cf.scale}`);
    }
    if (lf.copybook.pic !== cf.pic) diffs.push(`pic ${lf.copybook.pic} != ${cf.pic}`);
    if (lf.copybook.line !== cf.line) diffs.push(`line ${lf.copybook.line} != ${cf.line}`);
    if (diffs.length > 0) throw new LayoutMismatch(`${where} field ${i} (${lf.name}): ${diffs.join("; ")}`);
  });
}
