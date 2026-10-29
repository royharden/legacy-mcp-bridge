// parity/reportParser.ts — parses LEGACY01 report text using only the column map in parity/printspec.json. Strict: every line
// is exactly lineWidth characters, the line type is known for the report, a page header opens every page (one per
// pageLength lines), literal columns hold their literal, unused columns are blank, body lines follow the report's order,
// one TRL per data file and a final END. Anything else throws ReportParseError (a parse failure fails the case).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ColumnSpec = z
  .object({
    name: z.string().min(1),
    start: z.number().int().min(5),
    width: z.number().int().min(1),
    kind: z.enum(["literal", "text", "code", "count", "money", "date", "rate", "taxid", "pointer", "volatile"]),
    value: z.string().optional(),
  })
  .strict();
const Columns = z.object({ columns: z.array(ColumnSpec).min(1) }).passthrough();

export const PrintspecSchema = z
  .object({
    version: z.literal(1),
    program: z.string(),
    lineWidth: z.number().int().min(1),
    pageLength: z.number().int().min(3),
    lineTerminator: z.literal("\n"),
    pageHeader: Columns.extend({ lineType: z.string().length(3) }),
    columnHeading: z.object({ lineType: z.string().length(3) }).passthrough(),
    trailer: Columns.extend({ lineType: z.string().length(3) }),
    endOfReport: Columns.extend({ lineType: z.string().length(3) }),
    reports: z.record(
      z
        .object({
          files: z.array(z.string()).min(1),
          headingFrom: z.string().nullable(),
          lineTypes: z.record(Columns),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type Printspec = z.output<typeof PrintspecSchema>;
export type ColumnDef = z.output<typeof ColumnSpec>;

export function loadPrintspec(path: string = join(fileURLToPath(new URL(".", import.meta.url)), "printspec.json")): Printspec {
  return PrintspecSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** money/rate: bigint minor units (null = not numeric, printed '?'); count: number; date: ISO | null (NEVER) | "INVALID". */
export type ParsedValue = string | number | bigint | null;

export type ParsedLine = {
  type: string;
  /** One-based line number in the report text. */
  lineNo: number;
  page: number;
  values: Record<string, ParsedValue>;
};

export type ParsedReport = {
  report: string;
  view: string;
  pages: number;
  headers: ParsedLine[];
  /** Body lines in order (no HDR, COL, TRL or END). */
  body: ParsedLine[];
  trailers: ParsedLine[];
  lineCount: number;
};

export class ReportParseError extends Error {
  readonly lineNo: number | null;
  constructor(message: string, lineNo: number | null = null) {
    super(lineNo === null ? `report parse: ${message}` : `report parse: line ${lineNo}: ${message}`);
    this.name = "ReportParseError";
    this.lineNo = lineNo;
  }
}

// Body grammar per report, over the space-joined body line types (from printspec "order"; TRL/END are checked apart).
const BODY_ORDER: Readonly<Record<string, RegExp>> = {
  INQUIRY: /^(AC1 AC2|NFD)$/,
  LIST: /^SEL( DTL)* FTR$/,
  HISTORY: /^SEL( DTL)* FTR$/,
  AGING: /^SEL( BKT){5} FTR( PTR)*$/,
  LAYOUT: /^REC( FLD)+ REC( FLD)+( POL){6} DIA DIA$/,
};

const PRINTABLE = /^[\x20-\x7e]*$/;
const MONEY_RE = /^ *(0|[1-9][0-9]{0,2}(?:,[0-9]{3})*)\.([0-9]{2})([- ])$/;
const ISO_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const POINTER_RE = /^(ACCTMSTR|TRANS)#[1-9][0-9]*$/;

function calendarDate(v: string): boolean {
  if (!ISO_RE.test(v)) return false;
  const y = Number.parseInt(v.slice(0, 4), 10);
  const m = Number.parseInt(v.slice(5, 7), 10);
  const d = Number.parseInt(v.slice(8, 10), 10);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
  return y > 0 && d >= 1 && d <= days;
}

function fail(message: string, lineNo: number | null = null): never {
  throw new ReportParseError(message, lineNo);
}

function parseValue(col: ColumnDef, slice: string, lineNo: number): ParsedValue {
  const where = `${col.name} [${col.start}+${col.width}]`;
  if (!PRINTABLE.test(slice)) fail(`${where} holds a non-printable character`, lineNo);
  switch (col.kind) {
    case "literal":
      if (slice !== col.value) fail(`${where} must be ${JSON.stringify(col.value)}, got ${JSON.stringify(slice)}`, lineNo);
      return slice;
    case "text":
    case "code":
    case "taxid":
    case "volatile":
      return slice.replace(/ +$/, "");
    case "count":
      if (!/^[0-9]+$/.test(slice)) fail(`${where} count ${JSON.stringify(slice)} is not ${col.width} digits`, lineNo);
      return Number.parseInt(slice, 10);
    case "money": {
      if (slice === "?".repeat(col.width)) return null;
      const m = MONEY_RE.exec(slice);
      if (m === null) fail(`${where} money ${JSON.stringify(slice)} is not an edited amount`, lineNo);
      const minor = BigInt((m[1] ?? "").replace(/,/g, "") + (m[2] ?? ""));
      return m[3] === "-" ? -minor : minor;
    }
    case "date": {
      const v = slice.replace(/ +$/, "");
      if (v === "NEVER") return null;
      if (v === "INVALID") return "INVALID";
      if (!calendarDate(v)) fail(`${where} date ${JSON.stringify(slice)} is not a real yyyy-mm-dd / NEVER / INVALID`, lineNo);
      return v;
    }
    case "rate": {
      if (slice === "?????") return null;
      const m = /^([0-9])\.([0-9]{3})$/.exec(slice);
      if (m === null) fail(`${where} rate ${JSON.stringify(slice)} is not 9.999`, lineNo);
      return BigInt((m[1] ?? "") + (m[2] ?? ""));
    }
    case "pointer": {
      const v = slice.replace(/ +$/, "");
      if (v === "") return null;
      if (!POINTER_RE.test(v)) fail(`${where} pointer ${JSON.stringify(slice)} is not FILE#n`, lineNo);
      return v;
    }
  }
}

function parseLine(type: string, columns: readonly ColumnDef[], text: string, lineNo: number, page: number): ParsedLine {
  const covered = new Array<boolean>(text.length).fill(false);
  for (let i = 0; i < 4; i++) covered[i] = true;
  if (text[3] !== " ") fail("column 4 must be blank", lineNo);
  const values: Record<string, ParsedValue> = {};
  for (const col of columns) {
    const from = col.start - 1;
    const to = from + col.width;
    if (to > text.length) fail(`${col.name} runs past the line end`, lineNo);
    for (let i = from; i < to; i++) covered[i] = true;
    values[col.name] = parseValue(col, text.slice(from, to), lineNo);
  }
  for (let i = 0; i < text.length; i++) {
    if (!covered[i] && text[i] !== " ") fail(`unused column ${i + 1} is not blank`, lineNo);
  }
  return { type, lineNo, page, values };
}

function headingText(spec: Printspec, columns: readonly ColumnDef[]): string {
  const chars = new Array<string>(spec.lineWidth).fill(" ");
  const put = (start: number, s: string, width: number): void => {
    for (let i = 0; i < width; i++) chars[start - 1 + i] = i < s.length ? (s[i] ?? " ") : " ";
  };
  put(1, spec.columnHeading.lineType, 3);
  for (const c of columns) put(c.start, c.name.toUpperCase(), c.width);
  return chars.join("");
}

export function parseReport(report: string, stdout: string, spec: Printspec): ParsedReport {
  const rspec = spec.reports[report];
  const order = BODY_ORDER[report];
  if (rspec === undefined || order === undefined) fail(`report ${JSON.stringify(report)} is not in the printspec`);
  if (stdout.length === 0) fail("empty output (truncated report)");
  if (!stdout.endsWith(spec.lineTerminator)) fail("output does not end with a line terminator (truncated report)");
  if (stdout.includes("\r")) fail("carriage return in output");
  const lines = stdout.slice(0, -1).split(spec.lineTerminator);

  let heading: string | null = null;
  if (rspec.headingFrom !== null) {
    const from = rspec.lineTypes[rspec.headingFrom];
    if (from === undefined) fail(`headingFrom ${rspec.headingFrom} has no line type`);
    heading = headingText(spec, from.columns);
  }
  const hdrType = spec.pageHeader.lineType;
  const colType = spec.columnHeading.lineType;
  const trlType = spec.trailer.lineType;
  const endType = spec.endOfReport.lineType;

  const headers: ParsedLine[] = [];
  const body: ParsedLine[] = [];
  const trailers: ParsedLine[] = [];
  let ended = false;
  let page = 0;
  let view: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    const lineNo = i + 1;
    if (text.length !== spec.lineWidth) fail(`line is ${text.length} characters, not ${spec.lineWidth}`, lineNo);
    const type = text.slice(0, 3);
    const pos = i % spec.pageLength;
    if (ended) fail("text after END", lineNo);
    if (pos === 0) {
      if (type !== hdrType) fail(`page ${page + 1} must start with ${hdrType}, got ${JSON.stringify(type)}`, lineNo);
      page++;
      const h = parseLine(type, spec.pageHeader.columns, text, lineNo, page);
      if (h.values.report !== report) fail(`page header names report ${String(h.values.report)}`, lineNo);
      if (h.values.page !== page) fail(`page header number ${String(h.values.page)}, expected ${page}`, lineNo);
      const v = h.values.view;
      if (v !== "ATTACKED" && v !== "CLEAN") fail(`page header view ${String(v)}`, lineNo);
      if (view !== null && v !== view) fail("page header view changes between pages", lineNo);
      view = v;
      headers.push(h);
      continue;
    }
    if (type === hdrType) fail(`${hdrType} outside a page boundary (every ${spec.pageLength} lines)`, lineNo);
    if (pos === 1 && heading !== null) {
      if (text !== heading) fail(`expected the ${colType} heading line`, lineNo);
      continue;
    }
    if (type === colType) fail(`unexpected ${colType} line`, lineNo);
    if (type === trlType) {
      trailers.push(parseLine(type, spec.trailer.columns, text, lineNo, page));
      continue;
    }
    if (type === endType) {
      parseLine(type, spec.endOfReport.columns, text, lineNo, page);
      ended = true;
      continue;
    }
    if (trailers.length > 0) fail(`${type} line after the trailer`, lineNo);
    const lt = rspec.lineTypes[type];
    if (lt === undefined) fail(`unknown line type ${JSON.stringify(type)} for ${report}`, lineNo);
    body.push(parseLine(type, lt.columns, text, lineNo, page));
  }

  if (!ended) fail("no END line (truncated report)");
  const tokens = body.map((l) => l.type).join(" ");
  if (!order.test(tokens)) fail(`body line order ${JSON.stringify(tokens.slice(0, 80))} does not match ${report}`);
  const files = trailers.map((t) => t.values.file);
  if (files.join(",") !== rspec.files.join(",")) fail(`trailers ${files.join(",")} but ${report} reads ${rspec.files.join(",")}`);
  if (report === "LAYOUT") checkLayoutCounts(body);
  return { report, view: view ?? "", pages: page, headers, body, trailers, lineCount: lines.length };
}

/** Each REC line announces how many FLD lines follow it. */
function checkLayoutCounts(body: readonly ParsedLine[]): void {
  let expected = -1;
  let seen = 0;
  const close = (lineNo: number): void => {
    if (expected >= 0 && seen !== expected) fail(`REC announces ${expected} fields, ${seen} FLD lines follow`, lineNo);
  };
  for (const l of body) {
    if (l.type === "REC") {
      close(l.lineNo);
      expected = typeof l.values.fields === "number" ? l.values.fields : -1;
      seen = 0;
    } else if (l.type === "FLD") {
      seen++;
    } else {
      close(l.lineNo);
      expected = -1;
    }
  }
}
