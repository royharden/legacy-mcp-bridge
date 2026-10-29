// parity/tolerances.ts — loads and validates parity/tolerances.json. Exactly two kinds exist: ignore_volatile (an oracle
// volatile column, i.e. the page-header run timestamp) and expected_divergence (the tax id, where the bridge must equal
// mask(oracle)). Every entry needs a reason and explicit, existing case ids; wildcards are rejected; after a run, any
// declared (tolerance, case) pair that the comparator never applied to a case that ran is a stale declaration and an error.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { VOLATILE_FIELDS, knownFieldPaths } from "./projections.ts";

export const TOLERANCE_KINDS = ["ignore_volatile", "expected_divergence"] as const;
export type ToleranceKind = (typeof TOLERANCE_KINDS)[number];

const MIN_REASON = 10;
// Glob/regex metacharacters; the literal row marker "[]" of projected paths (rows[].name) is not a wildcard.
const WILDCARD = /[*?{}^$|+\\]|\[(?!\])/;

const ToleranceEntry = z
  .object({
    id: z.string().regex(/^[a-z0-9_]+$/),
    kind: z.enum(TOLERANCE_KINDS),
    field: z.string(),
    reason: z.string().optional(),
    cases: z.array(z.string()),
    transform: z.enum(["mask_taxid"]).optional(),
  })
  .strict();

const ToleranceFile = z.object({ version: z.literal(1), tolerances: z.array(ToleranceEntry) }).strict();

export type Tolerance = {
  id: string;
  kind: ToleranceKind;
  field: string;
  reason: string;
  cases: string[];
  transform?: "mask_taxid";
};

export class ToleranceError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`tolerances invalid:\n  ${problems.join("\n  ")}`);
    this.name = "ToleranceError";
    this.problems = problems;
  }
}

export const TOLERANCES_PATH = join(fileURLToPath(new URL(".", import.meta.url)), "tolerances.json");

export function loadTolerances(knownCaseIds: ReadonlySet<string>, path: string = TOLERANCES_PATH): Tolerance[] {
  return validateTolerances(JSON.parse(readFileSync(path, "utf8")), knownCaseIds);
}

/** Validates the file content against the declared case ids; throws ToleranceError listing every problem. */
export function validateTolerances(raw: unknown, knownCaseIds: ReadonlySet<string>): Tolerance[] {
  const parsed = ToleranceFile.safeParse(raw);
  if (!parsed.success) {
    throw new ToleranceError(parsed.error.issues.map((i) => `${i.path.join(".") || "(file)"}: ${i.message}`));
  }
  const problems: string[] = [];
  const fields = knownFieldPaths();
  const ids = new Set<string>();
  const pairs = new Set<string>();
  const out: Tolerance[] = [];
  for (const t of parsed.data.tolerances) {
    const at = `tolerance ${t.id}`;
    if (ids.has(t.id)) problems.push(`${at}: duplicate id`);
    ids.add(t.id);
    const reason = (t.reason ?? "").trim();
    if (reason.length < MIN_REASON) problems.push(`${at}: unreasoned (a reason of at least ${MIN_REASON} characters is required)`);
    if (WILDCARD.test(t.field)) problems.push(`${at}: wildcard field ${JSON.stringify(t.field)} is not allowed`);
    else if (!fields.has(t.field)) problems.push(`${at}: unknown field ${JSON.stringify(t.field)}`);
    if (t.kind === "ignore_volatile") {
      if (!(VOLATILE_FIELDS as readonly string[]).includes(t.field)) {
        problems.push(`${at}: ignore_volatile may only name a volatile oracle column (${VOLATILE_FIELDS.join(", ")})`);
      }
      if (t.transform !== undefined) problems.push(`${at}: ignore_volatile takes no transform`);
    } else {
      if (t.transform === undefined) problems.push(`${at}: expected_divergence needs a transform`);
      if (t.transform === "mask_taxid" && t.field !== "tax_id") problems.push(`${at}: mask_taxid applies only to tax_id`);
    }
    if (t.cases.length === 0) problems.push(`${at}: lists no cases`);
    const seen = new Set<string>();
    for (const c of t.cases) {
      if (WILDCARD.test(c)) problems.push(`${at}: wildcard case ${JSON.stringify(c)} is not allowed`);
      else if (!knownCaseIds.has(c)) problems.push(`${at}: case ${c} does not exist`);
      if (seen.has(c)) problems.push(`${at}: case ${c} listed twice`);
      seen.add(c);
      const pair = `${t.kind}|${t.field}|${c}`;
      if (pairs.has(pair)) problems.push(`${at}: ${t.field} for ${c} is already declared by another tolerance`);
      pairs.add(pair);
    }
    const entry: Tolerance = { id: t.id, kind: t.kind, field: t.field, reason, cases: [...t.cases] };
    if (t.transform !== undefined) entry.transform = t.transform;
    out.push(entry);
  }
  if (problems.length > 0) throw new ToleranceError(problems);
  return out;
}

/** The tolerance (if any) declared for this kind, field and case. */
export function findTolerance(
  tolerances: readonly Tolerance[],
  kind: ToleranceKind,
  field: string,
  caseId: string,
): Tolerance | null {
  return tolerances.find((t) => t.kind === kind && t.field === field && t.cases.includes(caseId)) ?? null;
}

export type ToleranceUse = { tolerance: string; case: string };

/**
 * Stale declarations: a (tolerance, case) pair whose case ran in this run but which the comparator never applied.
 * Pairs for cases outside this run (e.g. seeded ids during a trap-only run) are not judged.
 */
export function unusedTolerances(
  tolerances: readonly Tolerance[],
  ranCaseIds: ReadonlySet<string>,
  used: Iterable<ToleranceUse>,
): string[] {
  const usedKeys = new Set<string>();
  for (const u of used) usedKeys.add(`${u.tolerance}|${u.case}`);
  const problems: string[] = [];
  for (const t of tolerances) {
    for (const c of t.cases) {
      if (ranCaseIds.has(c) && !usedKeys.has(`${t.id}|${c}`)) {
        problems.push(`tolerance ${t.id}: unused for case ${c} (stale declaration)`);
      }
    }
  }
  return problems;
}
