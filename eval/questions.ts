// Load only the explicitly selected split; dev tooling never opens the held-out file or enumerates its policies.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { argvProblem } from "../parity/caseSchema.ts";

export const EVAL_ROOT = fileURLToPath(new URL("./", import.meta.url));
export const QuestionSchema = z.object({
  id: z.string().regex(/^(DEV|HLD)[0-9]{2}$/), split: z.enum(["dev", "heldout"]),
  category: z.enum(["account", "account_search", "history", "aging", "layout", "refusal", "injection", "clean_twin"]),
  prompt: z.string().min(1), view: z.enum(["attacked", "clean"]),
  pair_id: z.string().nullable(),
  oracle: z.object({ report: z.enum(["INQUIRY", "LIST", "HISTORY", "AGING", "LAYOUT"]), argv: z.array(z.string()) }).strict().nullable(),
  selection: z.object({ kind: z.enum(["value", "count", "sum", "list"]), field: z.string(), record: z.string().optional(), bucket: z.string().optional() }).strict().nullable(),
}).strict().superRefine((q, ctx) => {
  if (q.category === "refusal" ? q.oracle !== null || q.selection !== null : q.oracle === null || q.selection === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "only refusal has policy truth; factual questions need both oracle and selection" });
  if (q.oracle !== null) {
    const error = argvProblem(q.oracle.report, q.oracle.argv);
    if (error !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
  }
  if ((q.category === "injection" || q.category === "clean_twin") !== (q.pair_id !== null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "safety twins need a pair id" });
});
export type Question = z.output<typeof QuestionSchema>;
export type Split = Question["split"];

export function loadQuestions(split: Split = "dev", root = EVAL_ROOT): Question[] {
  if (split !== "dev" && split !== "heldout") throw new Error("select dev or heldout explicitly");
  const rows = readFileSync(join(root, `questions.${split}.jsonl`), "utf8").trim().split(/\r?\n/).map((line) => QuestionSchema.parse(JSON.parse(line)));
  if (rows.length !== 30 || rows.some((q) => q.split !== split) || new Set(rows.map((q) => q.id)).size !== rows.length) throw new Error("split must contain 30 unique assigned questions");
  const count = (category: Question["category"]): number => rows.filter((q) => q.category === category).length;
  if (count("refusal") !== 3 || count("injection") !== (split === "dev" ? 1 : 2) || count("clean_twin") !== (split === "dev" ? 1 : 2)) throw new Error("safety allocation changed");
  for (const q of rows.filter((row) => row.category === "injection")) {
    const twin = rows.find((row) => row.pair_id === q.pair_id && row.category === "clean_twin");
    if (twin === undefined || twin.prompt !== q.prompt || q.view !== "attacked" || twin.view !== "clean" || JSON.stringify(twin.oracle) !== JSON.stringify(q.oracle) || JSON.stringify(twin.selection) !== JSON.stringify(q.selection)) throw new Error("invalid injection/clean pair");
  }
  return rows;
}
