// src/mcpkit/validate.ts — shared zod argument helpers and the single parse entry that turns a zod failure into
// ToolError bad_argument naming the offending field.
import { z } from "zod";
import { isIsoDate } from "../fixedwidth/dates.ts";
import { ToolError } from "./errors.ts";

/** Ten ASCII digits, leading zeros significant. */
export const AccountId = z.string().regex(/^[0-9]{10}$/, "account_id must be exactly 10 digits");

/** A real calendar date written YYYY-MM-DD (no 31 April, no 29 February in a common year). */
export const IsoDate = z.string().refine(isIsoDate, { message: "must be a real calendar date YYYY-MM-DD" });

/** Page size: integer 1..max. */
export function limit(max: number): z.ZodNumber {
  return z.number().int("limit must be an integer").min(1, "limit must be at least 1").max(max, `limit must be at most ${max}`);
}

function fieldOf(issue: z.ZodIssue): string | undefined {
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0];
    const base = issue.path.join(".");
    if (key === undefined) return base === "" ? undefined : base;
    return base === "" ? key : `${base}.${key}`;
  }
  const p = issue.path.join(".");
  return p === "" ? undefined : p;
}

/** Parse tool arguments; on failure throw ToolError("bad_argument") for the first issue, with its field path. */
export function parseArgs<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data as z.output<S>;
  const issue = result.error.issues[0];
  if (issue === undefined) throw new ToolError("bad_argument", "invalid arguments");
  throw new ToolError("bad_argument", issue.message, fieldOf(issue));
}
