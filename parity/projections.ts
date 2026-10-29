// parity/projections.ts — the catalogue of named parity projections: which bridge tool pairs with which oracle report, and
// every compared field path with its one comparator rule. Shared by caseSchema.ts (case validation), tolerances.ts
// (field validation) and comparator.ts (the comparison itself). Nothing here imports src/.

export const RULES = ["money", "date", "trim", "exact", "order", "pointer"] as const;
export type Rule = (typeof RULES)[number];

export const TOOL_NAMES = [
  "describe_layouts",
  "account_get",
  "accounts_find",
  "transactions_list",
  "aging_summary",
] as const;
export type ParityTool = (typeof TOOL_NAMES)[number];

export const ORACLE_REPORTS = ["INQUIRY", "LIST", "HISTORY", "AGING", "LAYOUT"] as const;
export type OracleReport = (typeof ORACLE_REPORTS)[number];

export const MUTANT_NAMES = [
  "pivot_off_by_one",
  "round_not_truncate",
  "overpunch_sign_misread",
  "calendar_day_aging",
  "last_duplicate_wins",
  "trailing_spaces_kept",
  "lowvalues_leak",
  "taxid_unmasked",
  "truncated_record_not_skipped",
  "status_x_treated_open",
  "no_truncation_marker",
  "cursor_off_by_one",
] as const;

export type ProjectionDef = {
  tool: ParityTool;
  report: OracleReport;
  /** Compared field path -> its only rule. */
  fields: Readonly<Record<string, Rule>>;
  /** Oracle columns deliberately outside the projection, with the reason (not tolerances). */
  excluded: Readonly<Record<string, string>>;
};

export const PROJECTIONS = {
  account_inquiry: {
    tool: "account_get",
    report: "INQUIRY",
    fields: {
      found: "exact",
      source: "pointer",
      account_id: "exact",
      name: "trim",
      status: "exact",
      open_date: "date",
      balance_minor: "money",
      credit_limit_minor: "money",
      rate_thousandths: "exact",
      tax_id: "exact",
      memo: "trim",
      monthly_interest_minor: "money",
    },
    excluded: {
      "AC1.raw_status": "oracle-only diagnosis column; bridge exposes only the effective status (LEGACY-BEHAVIOUR 5.8)",
      "AC2.acct_id": "repeat of AC1.acct_id; checked structurally",
      "TRL.*": "file trailer; diagnostics are compared by layout_dictionary",
    },
  },
  accounts_list: {
    tool: "accounts_find",
    report: "LIST",
    fields: {
      rows: "order",
      "rows[].source": "pointer",
      "rows[].account_id": "exact",
      "rows[].name": "trim",
      "rows[].status": "exact",
      "rows[].open_date": "date",
      "rows[].balance_minor": "money",
      matched_count: "exact",
      balance_total_minor: "money",
    },
    excluded: {
      "DTL.raw_status": "oracle-only diagnosis column (LEGACY-BEHAVIOUR 5.8)",
      "SEL.*": "request echo outside the row/aggregate projection; case args and oracle argv are cross-checked, not SEL",
      "TRL.*": "file trailer; diagnostics are compared by layout_dictionary",
    },
  },
  transactions_history: {
    tool: "transactions_list",
    report: "HISTORY",
    fields: {
      rows: "order",
      "rows[].source": "pointer",
      "rows[].tran_id": "exact",
      "rows[].account_id": "exact",
      "rows[].date": "date",
      "rows[].type": "exact",
      "rows[].status": "exact",
      "rows[].amount_minor": "money",
      "rows[].desc": "trim",
      matched_count: "exact",
      debit_total_minor: "money",
      credit_total_minor: "money",
    },
    excluded: {
      "SEL.*": "request echo outside the row/aggregate projection; case args and oracle argv are cross-checked, not SEL",
      "TRL.*": "file trailer; diagnostics are compared by layout_dictionary",
    },
  },
  aging_buckets: {
    tool: "aging_summary",
    report: "AGING",
    fields: {
      as_of: "date",
      buckets: "order",
      "buckets[].bucket": "exact",
      "buckets[].count": "exact",
      "buckets[].amount_minor": "money",
      "buckets[].sources": "pointer",
      total_count: "exact",
      total_amount_minor: "money",
      source_complete: "exact",
      omitted_sources: "exact",
    },
    excluded: {
      "TRL.*": "file trailer; diagnostics are compared by layout_dictionary",
    },
  },
  layout_dictionary: {
    tool: "describe_layouts",
    report: "LAYOUT",
    fields: {
      layouts: "order",
      "layouts[].record": "exact",
      "layouts[].record_length": "exact",
      "layouts[].fields": "order",
      "layouts[].fields[].name": "exact",
      "layouts[].fields[].offset": "exact",
      "layouts[].fields[].length": "exact",
      "layouts[].fields[].type": "exact",
      "layouts[].fields[].scale": "exact",
      "layouts[].fields[].date_window": "exact",
      "layouts[].diagnostics.records_read": "exact",
      "layouts[].diagnostics.skipped_tail_bytes": "exact",
      "layouts[].diagnostics.duplicate_keys": "exact",
      policies: "exact",
    },
    excluded: {
      "FLD.pic": "PIC text is documentation only (PRINTSPEC LAYOUT)",
      "POL.value": "semantics id; the behaviour itself is verified by account_get / aging parity",
    },
  },
} as const satisfies Record<string, ProjectionDef>;

export type ProjectionId = keyof typeof PROJECTIONS;
export const PROJECTION_IDS = Object.keys(PROJECTIONS) as ProjectionId[];

export function isProjectionId(id: string): id is ProjectionId {
  return Object.prototype.hasOwnProperty.call(PROJECTIONS, id);
}

/** Oracle columns of kind "volatile" that only an ignore_volatile tolerance may excuse. */
export const VOLATILE_FIELDS = ["hdr.run_ts"] as const;

/** Every field path a tolerance may name: projected paths plus the volatile oracle columns. */
export function knownFieldPaths(): Set<string> {
  const out = new Set<string>(VOLATILE_FIELDS);
  for (const p of Object.values(PROJECTIONS) as ProjectionDef[]) {
    for (const f of Object.keys(p.fields)) out.add(f);
  }
  return out;
}

/**
 * Tax-id mask written independently of the bridge from LEGACY-BEHAVIOUR 5.9: `***-**-` + the last four characters of the
 * value with its trailing padding removed; a blank tax id stays blank.
 */
export function maskTaxIdForParity(raw: string): string {
  const value = raw.replace(/ +$/, "");
  if (value.trim() === "") return "";
  return "***-**-" + value.slice(-4);
}

/** A diff can contain a whole object/array after a shape mismatch; mask nested tax-id fields too. */
export function redactParityValue(value: unknown, path = ""): unknown {
  if (typeof value === "string" && /tax_?id/i.test(path)) return maskTaxIdForParity(value);
  if (Array.isArray(value)) return value.map((v) => redactParityValue(v, path));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redactParityValue(v, `${path}.${key}`)]));
  }
  return value;
}
