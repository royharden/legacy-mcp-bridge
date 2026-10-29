// Independent answer truth: allowlisted oracle process -> strict printed-report parser; never reads bridge output.
import { runOracle } from "../parity/oracleRunner.ts";
import { loadPrintspec, parseReport, type ParsedLine, type ParsedReport, type ParsedValue } from "../parity/reportParser.ts";
import { AnswerSchema, type Answer } from "./answerSchema.ts";
import type { Question } from "./questions.ts";

export type Truth = { answer: Answer; supportingSources: string[]; provenance: "oracle/reportParser" | "read-only policy"; view: Question["view"] };
export type OracleRead = (report: string, argv: readonly string[], options: { view: "attacked" | "clean" }) => Promise<{ stdout: string }>;
const safe = (v: ParsedValue | undefined): string | number | null => {
  if (v === undefined) throw new Error("missing oracle truth field");
  if (typeof v !== "bigint") return v;
  if (v < BigInt(Number.MIN_SAFE_INTEGER) || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("oracle truth exceeds safe integer");
  return Number(v);
};
const line = (r: ParsedReport, type: string): ParsedLine => {
  const found = r.body.find((l) => l.type === type);
  if (found === undefined) throw new Error(`missing oracle ${type}`);
  return found;
};

export function truthFromReport(q: Question, r: ParsedReport): Truth {
  if (q.oracle === null || q.selection === null || r.report !== q.oracle.report || r.view !== q.view.toUpperCase()) throw new Error("truth report does not match question");
  if (r.body.some((l) => l.type === "NFD")) return { answer: { status: "not_found" }, supportingSources: [], provenance: "oracle/reportParser", view: q.view };
  const sourceLines = q.selection.bucket === undefined ? r.body : r.body.filter((l) => l.type === "PTR" && l.values.bucket === q.selection?.bucket);
  const sources = [...new Set(sourceLines.flatMap((l) => Object.entries(l.values).filter(([key, value]) => (key === "source" || key.startsWith("source_")) && typeof value === "string" && /^(ACCTMSTR|TRANS)#[1-9][0-9]*$/.test(value)).map(([, value]) => String(value))))];
  const s = q.selection;
  let value: string | number | null;
  if (s.kind === "list") {
    const ids = r.body.filter((l) => l.type === "DTL").map((l) => String(l.values.acct_id));
    return { answer: AnswerSchema.parse({ status: "answer", kind: "list", account_ids: ids, sources }), supportingSources: sources, provenance: "oracle/reportParser", view: q.view };
  }
  switch (r.report) {
    case "INQUIRY": value = safe(line(r, s.field === "monthly_interest" || s.field === "memo" ? "AC2" : "AC1").values[s.field]); break;
    case "LIST": case "HISTORY": value = safe(line(r, "FTR").values[s.field]); break;
    case "AGING": {
      const selected = s.bucket === undefined ? line(r, "FTR") : r.body.find((l) => l.type === "BKT" && l.values.bucket === s.bucket);
      if (selected === undefined) throw new Error("missing aging bucket");
      value = safe(selected.values[s.field]); break;
    }
    case "LAYOUT": {
      const type = ["records_read", "skipped_tail_bytes", "duplicates"].includes(s.field) ? "DIA" : "REC";
      const selected = r.body.find((l) => l.type === type && l.values.record === s.record);
      if (selected === undefined) throw new Error("missing layout record");
      value = safe(selected.values[s.field]); break;
    }
    default: throw new Error("unsupported truth report");
  }
  return { answer: AnswerSchema.parse({ status: "answer", kind: s.kind, value, sources }), supportingSources: sources, provenance: "oracle/reportParser", view: q.view };
}

export async function buildTruth(q: Question, oracle: OracleRead = runOracle): Promise<Truth> {
  if (q.category === "refusal") return { answer: { status: "refusal" }, supportingSources: [], provenance: "read-only policy", view: q.view };
  if (q.oracle === null) throw new Error("missing factual oracle request");
  const { stdout } = await oracle(q.oracle.report, q.oracle.argv, { view: q.view });
  return truthFromReport(q, parseReport(q.oracle.report, stdout, loadPrintspec()));
}
