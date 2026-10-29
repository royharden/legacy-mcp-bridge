// parity/comparator.ts — compares bridge results with parsed oracle reports through the named projections in
// projections.ts. Rules: money (BigInt minor units, no epsilon), date (ISO or null), trim (oracle column padding removed,
// bridge text untouched), exact, order (positional row sequences), pointer (FILE#n). Tolerances are applied only where
// declared for the case: ignore_volatile for the page-header run timestamp, expected_divergence for the tax id (bridge must
// equal mask(oracle)). Every diff names case, field, both values (tax ids masked) and a source pointer.
import type { ToolResult } from "../src/bridge/createBridge.ts";
import type { ParityCase } from "./caseSchema.ts";
import { PROJECTIONS, maskTaxIdForParity, redactParityValue, type ProjectionId, type Rule } from "./projections.ts";
import type { ParsedLine, ParsedReport, ParsedValue } from "./reportParser.ts";
import { findTolerance, type Tolerance, type ToleranceUse } from "./tolerances.ts";

export { PROJECTIONS, PROJECTION_IDS } from "./projections.ts";

export type Diff = {
  case: string;
  field: string;
  bridge: string;
  oracle: string;
  pointer: string | null;
  message: string;
};

export type Applied = { tolerance: string; field: string; bridge: string; oracle: string };

export type CompareResult = {
  pass: boolean;
  matched: string[];
  ignored: Applied[];
  divergences: Applied[];
  diffs: Diff[];
  tolerancesUsed: ToleranceUse[];
  /** Set when the bridge answered with a structured error the oracle does not explain. */
  bridgeError: { code: string; message: string } | null;
};

/** What the harness observed from the bridge: one result per page (one unless paging.union), plus paging problems. */
export type BridgeObservation = { results: ToolResult[]; pagingProblems?: string[] };

const MAX_DIFFS = 50;
const POINTER_RE = /^(ACCTMSTR|TRANS)#[1-9][0-9]*$/;

// LEGACY-BEHAVIOUR 7.1: layouts JSON type (+ flags) -> oracle LAYOUT type. Any other pair is a parity failure.
export function oracleLayoutType(type: unknown, signed: unknown): string {
  switch (type) {
    case "alnum":
    case "lowvalues":
      return "alnum";
    case "packed":
      return "packed";
    case "zoned":
      return signed === true ? "zoned_signed" : "zoned";
    case "date_yymmdd":
      return "zoned";
    default:
      return `unmapped:${String(type)}`;
  }
}

export function oracleDateWindow(type: unknown, window: unknown): string {
  const w = window as { pivot?: unknown } | null | undefined;
  if (type === "date_yymmdd") {
    return w !== null && w !== undefined && typeof w.pivot === "number" ? `YYMMDD/${w.pivot}` : "unmapped:no-window";
  }
  return w === null || w === undefined ? "-" : "unmapped:window-on-non-date";
}

// Oracle LAYOUT policy -> describe_layouts rules key.
const POLICY_RULE_KEYS: Readonly<Record<string, string>> = {
  MASKING: "tax_id_mask",
  STATUS: "status_x",
  DUPLICATES: "duplicates",
  TAIL: "truncated_tail",
  INTEREST: "interest",
  AGING: "aging",
};

function show(v: unknown): string {
  if (v === undefined) return "(absent)";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return JSON.stringify(v);
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Display a value for a diff; tax ids are always masked, whichever side holds them. */
function display(field: string, v: unknown): string {
  return show(redactParityValue(v, field));
}

function textOf(v: unknown): unknown {
  if (typeof v === "object" && v !== null && "text" in v) return (v as { text: unknown }).text;
  return v;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function recordNo(pointer: ParsedValue): number {
  const m = typeof pointer === "string" ? /#([0-9]+)$/.exec(pointer) : null;
  return m === null ? Number.MAX_SAFE_INTEGER : Number.parseInt(m[1] ?? "", 10);
}

/** Rule equality. Returns null when equal, else a short reason. */
export function ruleProblem(rule: Rule, bridge: unknown, oracle: ParsedValue): string | null {
  switch (rule) {
    case "money": {
      if (oracle === null) return "oracle amount is not numeric";
      if (typeof oracle !== "bigint") return "oracle value is not money";
      if (typeof bridge !== "number" || !Number.isSafeInteger(bridge)) return "bridge amount is not a safe integer";
      return BigInt(bridge) === oracle ? null : "amounts differ";
    }
    case "date":
      if (oracle === "INVALID") return "oracle date is INVALID";
      return bridge === oracle ? null : "dates differ";
    case "trim":
      if (typeof bridge !== "string") return "bridge text is not a string";
      return bridge === oracle ? null : "text differs (oracle padding removed, bridge untouched)";
    case "pointer":
      if (typeof bridge !== "string" || !POINTER_RE.test(bridge)) return "bridge pointer is not FILE#n";
      return bridge === oracle ? null : "pointers differ";
    case "exact":
    case "order":
      if (typeof oracle === "bigint") {
        return typeof bridge === "number" && Number.isSafeInteger(bridge) && BigInt(bridge) === oracle ? null : "values differ";
      }
      return bridge === oracle ? null : "values differ";
  }
}

class Ctx {
  readonly c: ParityCase;
  readonly fields: Readonly<Record<string, Rule>>;
  readonly tolerances: readonly Tolerance[];
  readonly matched = new Set<string>();
  readonly ignored: Applied[] = [];
  readonly divergences: Applied[] = [];
  readonly diffs: Diff[] = [];
  readonly used: ToleranceUse[] = [];
  dropped = 0;

  constructor(c: ParityCase, projection: ProjectionId, tolerances: readonly Tolerance[]) {
    this.c = c;
    this.fields = PROJECTIONS[projection].fields;
    this.tolerances = tolerances;
  }

  diff(field: string, bridge: unknown, oracle: unknown, pointer: ParsedValue | string | null, message: string): void {
    if (this.diffs.length >= MAX_DIFFS) {
      this.dropped++;
      return;
    }
    this.diffs.push({
      case: this.c.id,
      field,
      bridge: display(field, bridge),
      oracle: display(field, oracle),
      pointer: typeof pointer === "string" ? pointer : null,
      message,
    });
  }

  /** Compare one projected field with its projection rule. `label` may carry a row index (rows[3].name). */
  eq(path: string, label: string, bridge: unknown, oracle: ParsedValue, pointer: ParsedValue | string | null): boolean {
    const rule = this.fields[path];
    if (rule === undefined) throw new Error(`comparator: ${path} is not in the projection`);
    if (path === "tax_id" || path.endsWith(".tax_id")) return this.taxId(path, label, bridge, oracle, pointer);
    const problem = ruleProblem(rule, rule === "trim" ? textOf(bridge) : bridge, oracle);
    if (problem === null) {
      this.matched.add(path);
      return true;
    }
    this.diff(label, rule === "trim" ? textOf(bridge) : bridge, oracle, pointer, `${rule}: ${problem}`);
    return false;
  }

  taxId(path: string, label: string, bridge: unknown, oracle: ParsedValue, pointer: ParsedValue | string | null): boolean {
    const tol = findTolerance(this.tolerances, "expected_divergence", path, this.c.id);
    if (tol === null) {
      if (bridge === oracle && typeof oracle === "string" && bridge === maskTaxIdForParity(oracle)) {
        this.matched.add(path);
        return true;
      }
      this.diff(label, bridge, oracle, pointer, "exact: a masked tax id requires an expected_divergence; raw tax ids never pass");
      return false;
    }
    this.used.push({ tolerance: tol.id, case: this.c.id });
    const expected = maskTaxIdForParity(typeof oracle === "string" ? oracle : "");
    if (bridge === expected) {
      this.divergences.push({ tolerance: tol.id, field: label, bridge: display(path, bridge), oracle: display(path, oracle) });
      return true;
    }
    this.diff(label, bridge, oracle, pointer, `expected_divergence ${tol.id}: bridge must equal mask(oracle) = ${JSON.stringify(expected)}`);
    return false;
  }

  /** Every page header's run timestamp must be excused by an ignore_volatile declaration for this case. */
  volatile(reports: readonly ParsedReport[]): void {
    const tol = findTolerance(this.tolerances, "ignore_volatile", "hdr.run_ts", this.c.id);
    for (const r of reports) {
      for (const h of r.headers) {
        if (tol === null) {
          this.diff("hdr.run_ts", "(none)", h.values.run_ts ?? null, `page ${h.page}`, "unexplained volatile oracle field (no ignore_volatile declared)");
          return;
        }
      }
    }
    if (tol !== null && reports.some((r) => r.headers.length > 0)) {
      this.used.push({ tolerance: tol.id, case: this.c.id });
      const first = reports[0]?.headers[0];
      this.ignored.push({ tolerance: tol.id, field: "hdr.run_ts", bridge: "(none)", oracle: show(first?.values.run_ts) });
    }
  }

  result(bridgeError: CompareResult["bridgeError"]): CompareResult {
    if (this.dropped > 0) {
      this.diffs.push({ case: this.c.id, field: "(more)", bridge: "", oracle: "", pointer: null, message: `${this.dropped} further diffs not shown` });
    }
    return {
      pass: this.diffs.length === 0 && bridgeError === null,
      matched: [...this.matched],
      ignored: this.ignored,
      divergences: this.divergences,
      diffs: this.diffs,
      tolerancesUsed: this.used,
      bridgeError,
    };
  }
}

function linesOf(r: ParsedReport, type: string): ParsedLine[] {
  return r.body.filter((l) => l.type === type);
}

function firstLine(r: ParsedReport | undefined, type: string): ParsedLine | undefined {
  return r?.body.find((l) => l.type === type);
}

/** Compare one case. `parsed` holds one parsed report per oracle invocation, in case order. */
export function compare(
  caseDef: ParityCase,
  bridge: BridgeObservation,
  parsed: readonly ParsedReport[],
  tolerances: readonly Tolerance[],
): CompareResult {
  if (caseDef.projection === null || !(caseDef.projection in PROJECTIONS)) {
    throw new Error(`comparator: case ${caseDef.id} has no parity projection`);
  }
  const projection = caseDef.projection as ProjectionId;
  const ctx = new Ctx(caseDef, projection, tolerances);
  const view = caseDef.view.toUpperCase();
  for (const r of parsed) {
    if (r.view !== view) ctx.diff("hdr.view", view, r.view, null, "oracle report was printed for a different view");
  }
  ctx.volatile(parsed);
  for (const p of bridge.pagingProblems ?? []) ctx.diff("rows", p, "(oracle full list)", null, "paging");

  const first = bridge.results[0];
  if (first === undefined) {
    ctx.diff("(result)", "(no call)", "(report)", null, "the bridge was never called");
    return ctx.result(null);
  }

  if (projection === "account_inquiry") {
    const r = parsed[0];
    const ac1 = firstLine(r, "AC1");
    const ac2 = firstLine(r, "AC2");
    const oracleFound = ac1 !== undefined;
    if (!first.ok) {
      if (!oracleFound && first.error.code === "not_found") {
        ctx.matched.add("found");
        return ctx.result(null);
      }
      if (!oracleFound) {
        ctx.diff("found", `error ${first.error.code}`, "ACCOUNT NOT FOUND", null, "oracle reports not found; bridge must answer not_found");
        return ctx.result(null);
      }
      ctx.diff("found", `error ${first.error.code}`, "found", ac1.values.source ?? null, "bridge error where the oracle printed the account");
      return ctx.result({ code: first.error.code, message: first.error.message });
    }
    if (!oracleFound || ac2 === undefined) {
      ctx.diff("found", true, false, null, "bridge returned an account the oracle does not find");
      return ctx.result(null);
    }
    ctx.matched.add("found");
    const row = asRecord(first.structured.data);
    const v = ac1.values;
    const ptr = v.source ?? null;
    if (ac2.values.acct_id !== v.acct_id) ctx.diff("account_id", v.acct_id, ac2.values.acct_id, ptr, "oracle AC1/AC2 disagree");
    ctx.eq("source", "source", row.source, v.source ?? null, ptr);
    ctx.eq("account_id", "account_id", row.account_id, v.acct_id ?? null, ptr);
    ctx.eq("name", "name", row.name, v.name ?? null, ptr);
    ctx.eq("status", "status", row.status, v.status ?? null, ptr);
    ctx.eq("open_date", "open_date", row.open_date, v.open_date ?? null, ptr);
    ctx.eq("balance_minor", "balance_minor", row.balance_minor, v.balance ?? null, ptr);
    ctx.eq("credit_limit_minor", "credit_limit_minor", row.credit_limit_minor, v.credit_limit ?? null, ptr);
    ctx.eq("rate_thousandths", "rate_thousandths", row.rate_thousandths, v.rate ?? null, ptr);
    ctx.eq("tax_id", "tax_id", row.tax_id, v.tax_id ?? null, ptr);
    ctx.eq("memo", "memo", row.memo, ac2.values.memo ?? null, ptr);
    ctx.eq("monthly_interest_minor", "monthly_interest_minor", row.monthly_interest_minor, ac2.values.monthly_interest ?? null, ptr);
    return ctx.result(null);
  }

  // Every remaining projection expects successful results on every page.
  const failed = bridge.results.find((x) => !x.ok);
  if (failed !== undefined && !failed.ok) {
    ctx.diff("(result)", `error ${failed.error.code}`, "report printed", null, "bridge returned a structured error");
    return ctx.result({ code: failed.error.code, message: failed.error.message });
  }
  const pages = bridge.results.map((x) => (x.ok ? x.structured : {}));

  if (projection === "accounts_list" || projection === "transactions_history") {
    compareRows(ctx, projection, caseDef, pages, parsed);
  } else if (projection === "aging_buckets") {
    compareAging(ctx, pages[0] ?? {}, parsed[0]);
  } else {
    compareLayout(ctx, pages[0] ?? {}, parsed[0]);
  }
  return ctx.result(null);
}

const ROW_MAP = {
  accounts_list: [
    ["rows[].source", "source", "source"],
    ["rows[].account_id", "account_id", "acct_id"],
    ["rows[].name", "name", "name"],
    ["rows[].status", "status", "status"],
    ["rows[].open_date", "open_date", "open_date"],
    ["rows[].balance_minor", "balance_minor", "balance"],
  ],
  transactions_history: [
    ["rows[].source", "source", "source"],
    ["rows[].tran_id", "tran_id", "tran_id"],
    ["rows[].account_id", "account_id", "acct_id"],
    ["rows[].date", "date", "tran_date"],
    ["rows[].type", "type", "tran_type"],
    ["rows[].status", "status", "tran_status"],
    ["rows[].amount_minor", "amount_minor", "amount"],
    ["rows[].desc", "desc", "desc"],
  ],
} as const;

const AGG_MAP = {
  accounts_list: [
    ["matched_count", "matched_count", "matched_count"],
    ["balance_total_minor", "balance_total_minor", "balance_total"],
  ],
  transactions_history: [
    ["matched_count", "matched_count", "matched_count"],
    ["debit_total_minor", "debit_total_minor", "debit_total"],
    ["credit_total_minor", "credit_total_minor", "credit_total"],
  ],
} as const;

function compareRows(
  ctx: Ctx,
  projection: "accounts_list" | "transactions_history",
  caseDef: ParityCase,
  pages: readonly Record<string, unknown>[],
  parsed: readonly ParsedReport[],
): void {
  // Oracle full list: DTL lines of every run, merged by physical record (the accounts_find status union); footers summed.
  const oracleRows = parsed.flatMap((r) => linesOf(r, "DTL")).sort((a, b) => recordNo(a.values.source ?? null) - recordNo(b.values.source ?? null));
  const footers = parsed.map((r) => firstLine(r, "FTR"));
  const agg: Record<string, ParsedValue> = {};
  for (const [, , col] of AGG_MAP[projection]) {
    let sum: bigint | number = col === "matched_count" ? 0 : 0n;
    for (const f of footers) {
      const v = f?.values[col];
      if (typeof v === "number" && typeof sum === "number") sum += v;
      else if (typeof v === "bigint" && typeof sum === "bigint") sum += v;
    }
    agg[col] = sum;
  }

  // Aggregates are over the whole match and must be identical on every page.
  pages.forEach((page, i) => {
    for (const [path, key, col] of AGG_MAP[projection]) {
      const label = pages.length > 1 ? `${path} (page ${i + 1})` : path;
      ctx.eq(path, label, page[key], agg[col] ?? null, null);
    }
  });

  const union = caseDef.paging?.union === true;
  const bridgeRows = union ? pages.flatMap((p) => asArray(p.data)) : asArray(pages[0]?.data);
  const seen = new Set<string>();
  for (const r of bridgeRows) {
    const src = asRecord(r).source;
    if (typeof src === "string") {
      if (seen.has(src)) ctx.diff("rows", src, "(once)", src, "order: duplicate row across pages");
      seen.add(src);
    }
  }
  if (union && bridgeRows.length !== oracleRows.length) {
    ctx.diff("rows", `${bridgeRows.length} rows`, `${oracleRows.length} rows`, null, "order: concatenated pages differ in length from the oracle list (gap or extra rows)");
  }
  if (!union) {
    if (bridgeRows.length > oracleRows.length) {
      ctx.diff("rows", `${bridgeRows.length} rows`, `${oracleRows.length} rows`, null, "order: page holds more rows than the oracle list");
    }
    const page = pages[0] ?? {};
    const remaining = bridgeRows.length < oracleRows.length;
    const truncated = page.truncated;
    const cursor = page.next_cursor;
    if (remaining && (truncated !== true || typeof cursor !== "string" || cursor === "")) {
      ctx.diff("rows", { truncated, next_cursor: cursor }, `${oracleRows.length - bridgeRows.length} more rows`, null, "order: rows remain but the page carries no truncation marker and cursor");
    }
    if (!remaining && (truncated !== false || cursor !== null)) {
      ctx.diff("rows", { truncated, next_cursor: cursor }, "no more rows", null, "order: complete page must not carry a truncation marker or cursor");
    }
    const limit = caseDef.paging?.limit;
    if (limit !== undefined && bridgeRows.length > limit) {
      ctx.diff("rows", `${bridgeRows.length} rows`, `limit ${limit}`, null, "order: page exceeds the requested limit");
    }
  }
  const n = Math.min(bridgeRows.length, oracleRows.length);
  let rowsOk = true;
  for (let i = 0; i < n; i++) {
    const b = asRecord(bridgeRows[i]);
    const o = oracleRows[i];
    if (o === undefined) break;
    const ptr = o.values.source ?? null;
    for (const [path, key, col] of ROW_MAP[projection]) {
      if (!ctx.eq(path, path.replace("rows[]", `rows[${i}]`), b[key], o.values[col] ?? null, ptr)) rowsOk = false;
    }
  }
  if (rowsOk && ctx.diffs.every((d) => d.field !== "rows")) ctx.matched.add("rows");
}

const BUCKETS = ["0", "1-30", "31-60", "61-90", ">90"] as const;

function compareAging(ctx: Ctx, page: Record<string, unknown>, r: ParsedReport | undefined): void {
  if (r === undefined) return;
  const data = asRecord(page.data);
  const sel = firstLine(r, "SEL");
  ctx.eq("as_of", "as_of", data.as_of, sel?.values.as_of ?? null, null);
  const bkts = linesOf(r, "BKT");
  const buckets = asArray(data.buckets);
  if (buckets.length !== bkts.length) {
    ctx.diff("buckets", `${buckets.length} buckets`, `${bkts.length} buckets`, null, "order: bucket count differs");
  } else {
    ctx.matched.add("buckets");
  }
  // Oracle pointers per bucket, in bucket then physical order.
  const ptrs = new Map<string, string[]>();
  for (const l of linesOf(r, "PTR")) {
    const label = String(l.values.bucket ?? "");
    const list = ptrs.get(label) ?? [];
    for (let k = 1; k <= 8; k++) {
      const p = l.values[`source_${k}`];
      if (typeof p === "string") list.push(p);
    }
    ptrs.set(label, list);
  }
  let oraclePointerTotal = 0;
  let listedTotal = 0;
  for (let i = 0; i < Math.min(buckets.length, bkts.length); i++) {
    const b = asRecord(buckets[i]);
    const o = bkts[i];
    if (o === undefined) break;
    const label = String(o.values.bucket ?? BUCKETS[i] ?? "");
    ctx.eq("buckets[].bucket", `buckets[${i}].bucket`, b.bucket, o.values.bucket ?? null, `bucket ${label}`);
    ctx.eq("buckets[].count", `buckets[${i}].count`, b.count, o.values.count ?? null, `bucket ${label}`);
    ctx.eq("buckets[].amount_minor", `buckets[${i}].amount_minor`, b.amount_minor, o.values.total ?? null, `bucket ${label}`);
    const oracleList = ptrs.get(label) ?? [];
    if (oracleList.length !== o.values.count) {
      ctx.diff(`buckets[${i}].sources`, "(n/a)", `${oracleList.length} PTR pointers vs COUNT ${String(o.values.count)}`, `bucket ${label}`, "oracle PTR lines disagree with the bucket count");
    }
    oraclePointerTotal += oracleList.length;
    const listed = asArray(b.sources);
    listedTotal += listed.length;
    listed.forEach((src, k) => {
      ctx.eq("buckets[].sources", `buckets[${i}].sources[${k}]`, src, oracleList[k] ?? null, oracleList[k] ?? `bucket ${label}`);
    });
    const omitted = b.omitted_sources;
    if (omitted !== oracleList.length - listed.length) {
      ctx.diff(`buckets[${i}].omitted_sources`, omitted, oracleList.length - listed.length, `bucket ${label}`, "exact: listed + omitted sources must equal the oracle pointer count");
    }
  }
  const ftr = firstLine(r, "FTR");
  ctx.eq("total_count", "total_count", page.total_count, ftr?.values.matched_count ?? null, null);
  ctx.eq("total_amount_minor", "total_amount_minor", page.total_amount_minor, ftr?.values.amount_total ?? null, null);
  const omittedTotal = oraclePointerTotal - listedTotal;
  ctx.eq("omitted_sources", "omitted_sources", page.omitted_sources, omittedTotal, null);
  ctx.eq("source_complete", "source_complete", page.source_complete === true ? "true" : String(page.source_complete), omittedTotal === 0 ? "true" : "false", null);
}

function compareLayout(ctx: Ctx, page: Record<string, unknown>, r: ParsedReport | undefined): void {
  if (r === undefined) return;
  const data = asRecord(page.data);
  const layouts = asArray(data.layouts).map(asRecord);
  // Group oracle body into REC blocks.
  const blocks: { rec: ParsedLine; flds: ParsedLine[] }[] = [];
  for (const l of r.body) {
    if (l.type === "REC") blocks.push({ rec: l, flds: [] });
    else if (l.type === "FLD") blocks[blocks.length - 1]?.flds.push(l);
  }
  if (layouts.length !== blocks.length) {
    ctx.diff("layouts", `${layouts.length} layouts`, `${blocks.length} REC lines`, null, "order: layout count differs");
  } else {
    ctx.matched.add("layouts");
  }
  for (let i = 0; i < Math.min(layouts.length, blocks.length); i++) {
    const b = layouts[i] ?? {};
    const blk = blocks[i];
    if (blk === undefined) break;
    const rec = String(blk.rec.values.record ?? "");
    ctx.eq("layouts[].record", `layouts[${i}].record`, b.record, rec, rec);
    ctx.eq("layouts[].record_length", `layouts[${i}].record_length`, b.record_length, blk.rec.values.length ?? null, rec);
    const fields = asArray(b.fields).map(asRecord);
    if (fields.length !== blk.flds.length || fields.length !== blk.rec.values.fields) {
      ctx.diff(`layouts[${i}].fields`, `${fields.length} fields`, `${blk.flds.length} FLD lines`, rec, "order: field count differs");
    } else {
      ctx.matched.add("layouts[].fields");
    }
    for (let k = 0; k < Math.min(fields.length, blk.flds.length); k++) {
      const f = fields[k] ?? {};
      const o = blk.flds[k];
      if (o === undefined) break;
      if (o.values.record !== rec) ctx.diff(`layouts[${i}].fields[${k}]`, rec, o.values.record ?? null, rec, "oracle FLD belongs to another record");
      const at = `${rec}.${String(o.values.field ?? k)}`;
      const lbl = (p: string): string => `layouts[${i}].fields[${k}].${p}`;
      ctx.eq("layouts[].fields[].name", lbl("name"), f.name, o.values.field ?? null, at);
      ctx.eq("layouts[].fields[].offset", lbl("offset"), f.offset, o.values.offset ?? null, at);
      ctx.eq("layouts[].fields[].length", lbl("length"), f.length, o.values.length ?? null, at);
      ctx.eq("layouts[].fields[].type", lbl("type"), oracleLayoutType(f.type, f.signed), o.values.type ?? null, at);
      ctx.eq("layouts[].fields[].scale", lbl("scale"), f.scale, o.values.scale ?? null, at);
      ctx.eq("layouts[].fields[].date_window", lbl("date_window"), oracleDateWindow(f.type, f.date_window), o.values.date_window ?? null, at);
    }
    const diag = asRecord(b.diagnostics);
    const dia = linesOf(r, "DIA").find((l) => l.values.record === rec);
    const trl = r.trailers.find((l) => l.values.file === rec);
    if (dia === undefined || trl === undefined) {
      ctx.diff(`layouts[${i}].diagnostics`, rec, "(missing DIA/TRL)", rec, "oracle prints no diagnostics for this record");
      continue;
    }
    const d = (p: string): string => `layouts[${i}].diagnostics.${p}`;
    ctx.eq("layouts[].diagnostics.records_read", d("records_read"), diag.records_read, dia.values.records_read ?? null, `${rec} DIA`);
    ctx.eq("layouts[].diagnostics.skipped_tail_bytes", d("skipped_tail_bytes"), diag.skipped_tail_bytes, dia.values.skipped_tail_bytes ?? null, `${rec} DIA`);
    ctx.eq("layouts[].diagnostics.duplicate_keys", d("duplicate_keys"), diag.duplicate_keys, dia.values.duplicate_keys ?? null, `${rec} DIA`);
    ctx.eq("layouts[].diagnostics.records_read", d("records_read"), diag.records_read, trl.values.records_read ?? null, `${rec} TRL`);
    ctx.eq("layouts[].diagnostics.skipped_tail_bytes", d("skipped_tail_bytes"), diag.skipped_tail_bytes, trl.values.skipped_tail_bytes ?? null, `${rec} TRL`);
    ctx.eq("layouts[].diagnostics.duplicate_keys", d("duplicate_keys"), diag.duplicate_keys, trl.values.duplicates ?? null, `${rec} TRL`);
  }
  // Policies: each oracle policy must name a non-empty describe_layouts rule, and every such rule must be printed.
  const rules = asRecord(data.rules);
  const printed = linesOf(r, "POL").map((l) => String(l.values.policy ?? ""));
  const bridgeHas = Object.entries(POLICY_RULE_KEYS)
    .filter(([, key]) => typeof rules[key] === "string" && (rules[key] as string).length > 0)
    .map(([policy]) => policy);
  ctx.eq("policies", "policies", [...bridgeHas].sort().join(","), [...printed].sort().join(","), null);
}
