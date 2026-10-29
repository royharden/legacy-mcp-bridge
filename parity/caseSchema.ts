// parity/caseSchema.ts — the parity case contract (M3-INTERFACES "Case line"): a zod schema for one JSONL line, the strict
// per-report oracle argv grammar, and a loader that fails the whole file on any invalid line. Coder B's case files and the
// seeded generator must satisfy this schema.
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  MUTANT_NAMES,
  ORACLE_REPORTS,
  PROJECTIONS,
  RULES,
  TOOL_NAMES,
  isProjectionId,
  type OracleReport,
  type ProjectionDef,
} from "./projections.ts";

const ACCT_RE = /^[0-9]{10}$/;
const ISO_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const PREFIX_RE = /^[\x20-\x7e]{1,25}$/;

function isCalendarDate(s: string): boolean {
  const m = ISO_RE.exec(s);
  if (m === null) return false;
  const y = Number.parseInt(m[1] ?? "", 10);
  const mo = Number.parseInt(m[2] ?? "", 10);
  const d = Number.parseInt(m[3] ?? "", 10);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 0;
  return d <= dim;
}

/**
 * Validates oracle argv for one report (without `--view`, which the runner adds). Returns null when valid, else a reason.
 * The grammar is deliberately narrower than "any string": digits, ISO dates, status letters, keywords and a printable
 * prefix that cannot start with a dash.
 */
export function argvProblem(report: string, argv: readonly string[]): string | null {
  for (const a of argv) {
    if (a.startsWith("-")) return `argument ${JSON.stringify(a)} starts with a dash`;
  }
  switch (report) {
    case "INQUIRY":
      return argv.length === 1 && ACCT_RE.test(argv[0] ?? "") ? null : "INQUIRY takes exactly one 10-digit account id";
    case "LIST": {
      if (argv.length !== 2 && argv.length !== 4) return "LIST takes STATUS <A|S|C> [PREFIX <p>]";
      if (argv[0] !== "STATUS" || !["A", "S", "C"].includes(argv[1] ?? "")) return "LIST needs STATUS A, S or C";
      if (argv.length === 4 && (argv[2] !== "PREFIX" || !PREFIX_RE.test(argv[3] ?? ""))) {
        return "LIST PREFIX must be 1-25 printable characters";
      }
      return null;
    }
    case "HISTORY": {
      const [acct, from, to] = argv;
      if (argv.length !== 3 || acct === undefined || from === undefined || to === undefined) {
        return "HISTORY takes <acct10> <from> <to>";
      }
      if (!ACCT_RE.test(acct)) return "HISTORY account id must be 10 digits";
      if (!isCalendarDate(from) || !isCalendarDate(to)) return "HISTORY dates must be real yyyy-mm-dd dates";
      return from <= to ? null : "HISTORY from is after to";
    }
    case "AGING":
      return argv.length === 1 && isCalendarDate(argv[0] ?? "") ? null : "AGING takes one real yyyy-mm-dd date";
    case "LAYOUT":
      return argv.length === 0 ? null : "LAYOUT takes no arguments";
    default:
      return `report ${JSON.stringify(report)} is not allowed`;
  }
}

const OracleCall = z
  .object({
    report: z.enum(ORACLE_REPORTS),
    argv: z.array(z.string().max(64)).max(4),
  })
  .strict()
  .superRefine((o, ctx) => {
    const p = argvProblem(o.report, o.argv);
    if (p !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: p, path: ["argv"] });
  });

const Tag = z.string().regex(/^[a-z0-9_]+(:[a-z0-9_]+)?$/, "tag must be name or prefix:name in [a-z0-9_]");

export const CaseSchema = z
  .object({
    id: z.string().regex(/^(T[0-9]{2}|S[0-9]{3})$/, "id must be Tnn (trap) or Snnn (seeded)"),
    kind: z.enum(["parity", "contract"]),
    tool: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    args: z.record(z.unknown()),
    view: z.enum(["attacked", "clean"]).default("attacked"),
    oracle: z.union([OracleCall, z.array(OracleCall).min(1).max(3)]).nullable(),
    rules: z.record(z.enum(RULES)).default({}),
    projection: z.string().nullable(),
    paging: z
      .object({ limit: z.number().int().min(1).max(100), union: z.boolean() })
      .strict()
      .nullable()
      .default(null),
    expect: z.record(z.unknown()).nullable(),
    cap_bytes: z.number().int().min(1).optional(),
    tags: z.array(Tag).min(1),
    what_bug_this_catches: z.string().min(10),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string, path: (string | number)[] = []): void => {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message, path });
    };
    for (const t of c.tags) {
      if (t.startsWith("mutant:") && !(MUTANT_NAMES as readonly string[]).includes(t.slice(7))) {
        issue(`unknown mutant tag ${t}`, ["tags"]);
      }
    }
    if (c.id.startsWith("T")) {
      if (c.expect === null) issue("trap cases carry literal expectations (expect must not be null)", ["expect"]);
      if (!c.tags.some((t) => t.startsWith("trap:"))) issue("trap cases need a trap:<name> tag", ["tags"]);
    } else if (!c.tags.includes("seeded")) {
      issue("seeded cases carry the seeded tag", ["tags"]);
    }
    if (c.paging !== null) {
      if ("limit" in c.args || "cursor" in c.args) issue("with paging, args must not set limit or cursor", ["args"]);
      if (c.paging.union && c.tool !== "accounts_find" && c.tool !== "transactions_list") {
        issue("paging.union applies only to accounts_find and transactions_list", ["paging"]);
      }
    }
    if (c.kind === "contract") {
      if (c.oracle !== null) issue("contract cases have no oracle", ["oracle"]);
      if (c.projection !== null) issue("contract cases have no projection", ["projection"]);
      if (c.expect === null) issue("contract cases assert bridge-only expectations (expect must not be null)", ["expect"]);
      if (Object.keys(c.rules).length > 0) issue("contract cases have no comparator rules", ["rules"]);
      return;
    }
    // parity
    if (!(TOOL_NAMES as readonly string[]).includes(c.tool)) issue(`parity tool must be one of the five tools`, ["tool"]);
    if (c.oracle === null) {
      issue("parity cases need an oracle invocation", ["oracle"]);
      return;
    }
    if (c.projection === null || !isProjectionId(c.projection)) {
      issue(`unknown projection ${JSON.stringify(c.projection)}`, ["projection"]);
      return;
    }
    const proj: ProjectionDef = PROJECTIONS[c.projection];
    if (proj.tool !== c.tool) issue(`projection ${c.projection} belongs to ${proj.tool}`, ["projection"]);
    const calls = Array.isArray(c.oracle) ? c.oracle : [c.oracle];
    for (const call of calls) {
      if (call.report !== proj.report) issue(`projection ${c.projection} compares against ${proj.report}`, ["oracle"]);
    }
    if (calls.length > 1 && c.projection !== "accounts_list") {
      issue("several oracle runs are only allowed for accounts_list (status union)", ["oracle"]);
    }
    for (const [path, rule] of Object.entries(c.rules)) {
      const want = proj.fields[path];
      if (path.includes("*")) issue(`wildcard rule path ${path}`, ["rules", path]);
      else if (want === undefined) issue(`${path} is not a field of projection ${c.projection}`, ["rules", path]);
      else if (want !== rule) issue(`${path} is compared with rule ${want}, not ${rule}`, ["rules", path]);
    }
    const argsProblem = argsVersusArgv(c.args, calls);
    if (argsProblem !== null) issue(argsProblem, ["oracle"]);
  });

export type ParityCase = z.output<typeof CaseSchema>;
export type OracleInvocation = { report: OracleReport; argv: string[] };

export function oracleCalls(c: ParityCase): OracleInvocation[] {
  if (c.oracle === null) return [];
  return Array.isArray(c.oracle) ? c.oracle : [c.oracle];
}

/** The oracle argv must ask the same question as the tool args (a mismatch is a case-authoring bug). */
function argsVersusArgv(args: Record<string, unknown>, calls: readonly OracleInvocation[]): string | null {
  const first = calls[0];
  if (first === undefined) return "no oracle call";
  const a = first.argv;
  switch (first.report) {
    case "INQUIRY":
      return args.account_id === a[0] ? null : "INQUIRY account differs from args.account_id";
    case "HISTORY":
      if (args.account_id !== a[0]) return "HISTORY account differs from args.account_id";
      if (args.from !== undefined && args.from !== a[1]) return "HISTORY from differs from args.from";
      if (args.to !== undefined && args.to !== a[2]) return "HISTORY to differs from args.to";
      return null;
    case "AGING":
      return args.as_of === a[0] ? null : "AGING date differs from args.as_of";
    case "LIST": {
      const prefixes = new Set(calls.map((k) => (k.argv.length === 4 ? k.argv[3] : undefined)));
      if (prefixes.size !== 1 || [...prefixes][0] !== args.name_prefix) return "LIST prefix differs from args.name_prefix";
      if (calls.length === 1) return args.status === a[1] ? null : "LIST status differs from args.status";
      const statuses = calls.map((k) => k.argv[1]).sort();
      if (args.status !== undefined) return "a status union is only for accounts_find without a status";
      return statuses.join("") === "ACS" ? null : "a status union needs exactly STATUS A, S and C";
    }
    case "LAYOUT":
      return Object.keys(args).length === 0 ? null : "describe_layouts takes no arguments";
    default:
      return "unknown report";
  }
}

export class CaseFileError extends Error {
  readonly problems: string[];
  constructor(file: string, problems: string[]) {
    super(`${file}: ${problems.length} invalid case line(s)\n  ${problems.join("\n  ")}`);
    this.name = "CaseFileError";
    this.problems = problems;
  }
}

/** Parses JSONL text; any invalid line (bad JSON, schema failure, duplicate id) fails the whole file. */
export function parseCases(text: string, file = "<cases>"): ParityCase[] {
  const problems: string[] = [];
  const cases: ParityCase[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (e) {
      problems.push(`line ${i + 1}: not JSON (${e instanceof Error ? e.message : String(e)})`);
      return;
    }
    const r = CaseSchema.safeParse(json);
    if (!r.success) {
      for (const iss of r.error.issues) problems.push(`line ${i + 1}: ${iss.path.join(".") || "(case)"}: ${iss.message}`);
      return;
    }
    if (seen.has(r.data.id)) {
      problems.push(`line ${i + 1}: duplicate id ${r.data.id}`);
      return;
    }
    seen.add(r.data.id);
    cases.push(r.data);
  });
  if (problems.length > 0) throw new CaseFileError(file, problems);
  return cases;
}

export function loadCaseFile(path: string): ParityCase[] {
  return parseCases(readFileSync(path, "utf8"), path);
}
