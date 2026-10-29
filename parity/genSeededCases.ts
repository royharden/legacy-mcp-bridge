// parity/genSeededCases.ts — writes parity/cases.seeded.jsonl: 60 seeded parity cases (S001..S060), 12 per tool, drawn with
// mulberry32 from the seed in parity/seeded.manifest.json (deliberately different from the fixture generator's seed). Inputs are
// only constants restated from docs/LEGACY-BEHAVIOUR.md and fixtures/plants.json (id rule r + 39, the 739 gap, the tail key,
// the TRANS date range); it never imports the bridge source tree or reads generated fixtures, so cases do not inherit a bridge or generator bug.
// Seeded cases carry no literal `expect`: truth is the oracle report under the named projection. Run once at activation:
//   node --experimental-strip-types parity/genSeededCases.ts [--out <file>]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---- constants restated from LEGACY-BEHAVIOUR.md §1/§6 and plants.json (acctmstr.id_rule, sets.not_found) ----
const ACCT_RECORDS = 1000;
const ACCT_ID_OFFSET = 39; // ACCT-ID of physical record r is r + 39
const DUPLICATE_RECORD = 700; // carries 0000000289 again, so r + 39 = 739 exists nowhere
const ABSENT_IDS = ["0000000739", "0000001040", "0000000001", "9999999999"] as const;
// Unplanted TRANS dates span 2023-01-01..2024-12-31 (generator rule restated in plants/behaviour; planted rows lie inside it).
const DATE_FIRST = { y: 2023, m: 1, d: 1 } as const;
const DATE_SPAN_DAYS = 731;
const STATUSES = ["A", "S", "C"] as const;
// Prefixes: single capitals plus planted prefixes that are unique and identical in both views (never longer than ADMI).
const PLANTED_PREFIXES = ["ZEPHYR", "DUPLICATE", "PIVOT", "ADMI", "SMITH  JONES"] as const;
const ACCOUNTS_FIND_MAX = 50;
const TRANSACTIONS_LIST_MAX = 100;
const PER_TOOL = 12;

// ---- comparator wiring: projection ids and their full rule maps, exactly as declared in parity/projections.ts ----
const WIRING = {
  describe_layouts: {
    projection: "layout_dictionary",
    rules: {
      layouts: "order", "layouts[].record": "exact", "layouts[].record_length": "exact", "layouts[].fields": "order",
      "layouts[].fields[].name": "exact", "layouts[].fields[].offset": "exact", "layouts[].fields[].length": "exact",
      "layouts[].fields[].type": "exact", "layouts[].fields[].scale": "exact", "layouts[].fields[].date_window": "exact",
      "layouts[].diagnostics.records_read": "exact", "layouts[].diagnostics.skipped_tail_bytes": "exact",
      "layouts[].diagnostics.duplicate_keys": "exact", policies: "exact",
    },
  },
  account_get: {
    projection: "account_inquiry",
    rules: {
      found: "exact", source: "pointer", account_id: "exact", name: "trim", status: "exact", open_date: "date",
      balance_minor: "money", credit_limit_minor: "money", rate_thousandths: "exact", tax_id: "exact", memo: "trim",
      monthly_interest_minor: "money",
    },
  },
  accounts_find: {
    projection: "accounts_list",
    rules: {
      rows: "order", "rows[].source": "pointer", "rows[].account_id": "exact", "rows[].name": "trim", "rows[].status": "exact",
      "rows[].open_date": "date", "rows[].balance_minor": "money", matched_count: "exact", balance_total_minor: "money",
    },
  },
  transactions_list: {
    projection: "transactions_history",
    rules: {
      rows: "order", "rows[].source": "pointer", "rows[].tran_id": "exact", "rows[].account_id": "exact", "rows[].date": "date",
      "rows[].type": "exact", "rows[].status": "exact", "rows[].amount_minor": "money", "rows[].desc": "trim",
      matched_count: "exact", debit_total_minor: "money", credit_total_minor: "money",
    },
  },
  aging_summary: {
    projection: "aging_buckets",
    rules: {
      as_of: "date", buckets: "order", "buckets[].bucket": "exact", "buckets[].count": "exact", "buckets[].amount_minor": "money",
      "buckets[].sources": "pointer", total_count: "exact", total_amount_minor: "money", source_complete: "exact",
      omitted_sources: "exact",
    },
  },
} as const;

type Tool = keyof typeof WIRING;
type View = "attacked" | "clean";
type SeededCase = {
  id: string;
  kind: "parity";
  tool: Tool;
  args: Record<string, unknown>;
  view: View;
  oracle: { report: "INQUIRY" | "LIST" | "HISTORY" | "AGING" | "LAYOUT"; argv: string[] };
  rules: Record<string, string>;
  projection: string;
  paging: { limit: number; union: true } | null;
  expect: null;
  tags: string[];
  what_bug_this_catches: string;
};

/** mulberry32: 32-bit state, integer-only steps. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

type Rng = { int(n: number): number; pick<T>(xs: readonly T[]): T; chance(num: number, den: number): boolean };

function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (n: number): number => {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`rng.int(${n})`);
    return next() % n; // modulo bias is irrelevant for case selection
  };
  return {
    int,
    pick<T>(xs: readonly T[]): T {
      const x = xs[int(xs.length)];
      if (x === undefined) throw new Error("rng.pick on empty list");
      return x;
    },
    chance: (num, den) => int(den) < num,
  };
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** ISO date `offset` days after DATE_FIRST (pure calendar walk, no Date object). */
function isoFromOffset(offset: number): string {
  let { y, m, d } = { y: DATE_FIRST.y, m: DATE_FIRST.m, d: DATE_FIRST.d };
  let rest = offset;
  while (rest > 0) {
    const left = daysInMonth(y, m) - d;
    if (rest <= left) {
      d += rest;
      rest = 0;
    } else {
      rest -= left + 1;
      d = 1;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
  }
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

function presentAccountId(rng: Rng): string {
  let r = 1 + rng.int(ACCT_RECORDS);
  if (r === DUPLICATE_RECORD) r = 1 + rng.int(DUPLICATE_RECORD - 1); // 739 is the gap; absent ids are drawn on purpose below
  return pad(r + ACCT_ID_OFFSET, 10);
}

function dateRange(rng: Rng): [string, string] {
  const a = rng.int(DATE_SPAN_DAYS);
  const b = rng.int(DATE_SPAN_DAYS);
  return [isoFromOffset(Math.min(a, b)), isoFromOffset(Math.max(a, b))];
}

function base(tool: Tool, view: View): Pick<SeededCase, "kind" | "tool" | "view" | "rules" | "projection" | "expect"> {
  const w = WIRING[tool];
  return { kind: "parity", tool, view, rules: { ...w.rules }, projection: w.projection, expect: null };
}

function genCases(seed: number): SeededCase[] {
  const rng = makeRng(seed);
  const view = (): View => (rng.chance(1, 4) ? "clean" : "attacked");
  const out: Omit<SeededCase, "id">[] = [];

  for (let i = 0; i < PER_TOOL; i += 1) {
    out.push({
      ...base("describe_layouts", i % 2 === 0 ? "attacked" : "clean"),
      args: {},
      oracle: { report: "LAYOUT", argv: [] },
      paging: null,
      tags: ["seeded", "tool:describe_layouts"],
      what_bug_this_catches: "Layout projection or diagnostics drifting from the legacy LAYOUT report in either view.",
    });
  }

  // account_get: 10 present ids + 2 absent ids (positions chosen by the rng).
  const absentSlots = new Set<number>();
  while (absentSlots.size < 2) absentSlots.add(rng.int(PER_TOOL));
  for (let i = 0; i < PER_TOOL; i += 1) {
    const absent = absentSlots.has(i);
    const id = absent ? rng.pick(ABSENT_IDS) : presentAccountId(rng);
    out.push({
      ...base("account_get", view()),
      args: { account_id: id },
      oracle: { report: "INQUIRY", argv: [id] },
      paging: null,
      tags: ["seeded", "tool:account_get", absent ? "absent_id" : "present_id"],
      what_bug_this_catches: absent
        ? "An absent key (id gap, tail key or out-of-range id) answered with data instead of not_found / NFD."
        : "Any field decode, status, interest or masking disagreement with legacy INQUIRY on an arbitrary account.",
    });
  }

  // accounts_find: status always given (LIST requires it); prefix sometimes; paged union with a drawn limit.
  for (let i = 0; i < PER_TOOL; i += 1) {
    const status = rng.pick(STATUSES);
    const prefix = rng.chance(1, 2)
      ? undefined
      : rng.chance(1, 3)
        ? rng.pick(PLANTED_PREFIXES)
        : String.fromCharCode(65 + rng.int(26));
    const limit = 5 + rng.int(ACCOUNTS_FIND_MAX - 4); // 5..50
    const args: Record<string, unknown> = { status }; // limit lives in paging (the harness sets it)
    const argv = ["STATUS", status];
    if (prefix !== undefined) {
      args["name_prefix"] = prefix;
      argv.push("PREFIX", prefix);
    }
    out.push({
      ...base("accounts_find", view()),
      args,
      oracle: { report: "LIST", argv },
      paging: { limit, union: true },
      tags: ["seeded", "tool:accounts_find", prefix === undefined ? "status_only" : "status_prefix"],
      what_bug_this_catches: "Filter, order, dedup, paging gap/duplicate or whole-match aggregate disagreeing with legacy LIST.",
    });
  }

  // transactions_list: mostly present accounts, one absent id; inclusive date ranges inside the fixture range.
  const absentTxSlot = rng.int(PER_TOOL);
  for (let i = 0; i < PER_TOOL; i += 1) {
    const absent = i === absentTxSlot;
    const id = absent ? rng.pick(ABSENT_IDS) : presentAccountId(rng);
    const [from, to] = dateRange(rng);
    const limit = 10 + rng.int(TRANSACTIONS_LIST_MAX - 9); // 10..100
    out.push({
      ...base("transactions_list", view()),
      args: { account_id: id, from, to }, // limit lives in paging
      oracle: { report: "HISTORY", argv: [id, from, to] },
      paging: { limit, union: true },
      tags: ["seeded", "tool:transactions_list", absent ? "absent_id" : "present_id"],
      what_bug_this_catches: absent
        ? "History of a key absent from ACCTMSTR erroring or returning rows instead of zero rows and zero totals."
        : "Date-range inclusivity, ownership, order, paging or debit/credit totals disagreeing with legacy HISTORY.",
    });
  }

  for (let i = 0; i < PER_TOOL; i += 1) {
    const asOf = isoFromOffset(rng.int(DATE_SPAN_DAYS));
    out.push({
      ...base("aging_summary", view()),
      args: { as_of: asOf },
      oracle: { report: "AGING", argv: [asOf] },
      paging: null,
      tags: ["seeded", "tool:aging_summary"],
      what_bug_this_catches: "Aging selection, 30E/360 day count, bucket edges or bucket totals disagreeing with legacy AGING.",
    });
  }

  return out.map((c, i) => ({ id: `S${pad(i + 1, 3)}`, ...c }));
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(readFileSync(join(here, "seeded.manifest.json"), "utf8")) as { seed?: unknown; count?: unknown };
  if (typeof manifest.seed !== "number" || !Number.isSafeInteger(manifest.seed)) throw new Error("manifest seed missing");
  const cases = genCases(manifest.seed);
  if (cases.length !== manifest.count) throw new Error(`generated ${cases.length} cases, manifest says ${String(manifest.count)}`);
  const outIdx = process.argv.indexOf("--out");
  const outArg = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;
  const outPath = outArg !== undefined ? resolve(outArg) : join(here, "cases.seeded.jsonl");
  writeFileSync(outPath, cases.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");
  process.stderr.write(`wrote ${cases.length} seeded cases (seed ${manifest.seed}) to ${outPath}\n`);
}

export { genCases };

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
