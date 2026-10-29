// tests/helpers/printspecReport.ts — builds literal LEGACY01 report text for the parity self-tests from the column map in
// parity/printspec.json (never from the oracle's own print code). Callers pass column values already edited (money and
// counts as printed); the helper places them: money/count right-aligned, everything else left-aligned, cut at width.
import { loadPrintspec, type ColumnDef, type Printspec } from "../../parity/reportParser.ts";

export const SPEC: Printspec = loadPrintspec();
export const RUN_TS = "2000-01-01 00:00:00";

function place(chars: string[], start: number, width: number, text: string, right: boolean): void {
  const s = right ? text.padStart(width, " ") : text;
  for (let i = 0; i < width; i++) chars[start - 1 + i] = i < s.length ? (s[i] ?? " ") : " ";
}

export function buildLine(type: string, columns: readonly ColumnDef[], values: Record<string, string>): string {
  const chars = new Array<string>(SPEC.lineWidth).fill(" ");
  place(chars, 1, 3, type, false);
  for (const c of columns) {
    const v = c.kind === "literal" ? (c.value ?? "") : (values[c.name] ?? "");
    place(chars, c.start, c.width, v, c.kind === "money" || c.kind === "count");
  }
  return chars.join("");
}

function columnsOf(report: string, type: string): readonly ColumnDef[] {
  const cols = SPEC.reports[report]?.lineTypes[type]?.columns;
  if (cols === undefined) throw new Error(`printspec has no ${report} ${type}`);
  return cols;
}

/** One body line of a report, e.g. body("INQUIRY", "AC1", {...}). */
export function body(report: string, type: string, values: Record<string, string>): string {
  return buildLine(type, columnsOf(report, type), values);
}

export function trailer(file: string, recordsRead: string, tail: string, dups: string): string {
  return buildLine(SPEC.trailer.lineType, SPEC.trailer.columns, {
    file,
    records_read: recordsRead,
    skipped_tail_bytes: tail,
    duplicates: dups,
  });
}

export function endLine(): string {
  return buildLine(SPEC.endOfReport.lineType, SPEC.endOfReport.columns, {});
}

function heading(report: string): string | null {
  const from = SPEC.reports[report]?.headingFrom;
  if (from === null || from === undefined) return null;
  const values: Record<string, string> = {};
  const cols = columnsOf(report, from).map((c) => {
    values[c.name] = c.name.toUpperCase();
    return { ...c, kind: "text" as const };
  });
  return buildLine(SPEC.columnHeading.lineType, cols, values);
}

/** Paginates body lines (including TRL and END) into pages of pageLength lines, each opened by HDR (+ COL). */
export function report(name: string, view: "ATTACKED" | "CLEAN", lines: readonly string[], runTs: string = RUN_TS): string {
  const head = heading(name);
  const perPage = SPEC.pageLength - 1 - (head === null ? 0 : 1);
  const out: string[] = [];
  let page = 0;
  let i = 0;
  do {
    page++;
    out.push(
      buildLine(SPEC.pageHeader.lineType, SPEC.pageHeader.columns, {
        report: name,
        view,
        run_ts: runTs,
        page: String(page).padStart(5, "0"),
      }),
    );
    if (head !== null) out.push(head);
    for (const stop = Math.min(lines.length, i + perPage); i < stop; i++) out.push(lines[i] ?? "");
  } while (i < lines.length);
  return out.join("\n") + "\n";
}

/** An INQUIRY report for one found account (values as printed). */
export function inquiryReport(opts: {
  record: number;
  acct: string;
  name: string;
  status: string;
  rawStatus?: string;
  openDate: string;
  balance: string;
  creditLimit: string;
  rate: string;
  taxId: string;
  memo: string;
  interest: string;
  view?: "ATTACKED" | "CLEAN";
}): string {
  return report("INQUIRY", opts.view ?? "ATTACKED", [
    body("INQUIRY", "AC1", {
      source: `ACCTMSTR#${opts.record}`,
      acct_id: opts.acct,
      name: opts.name,
      status: opts.status,
      raw_status: opts.rawStatus ?? opts.status,
      open_date: opts.openDate,
      balance: opts.balance,
      credit_limit: opts.creditLimit,
      rate: opts.rate,
      tax_id: opts.taxId,
    }),
    body("INQUIRY", "AC2", { acct_id: opts.acct, memo: opts.memo, monthly_interest: opts.interest }),
    trailer("ACCTMSTR", "0001000", "37", "00001"),
    endLine(),
  ]);
}
