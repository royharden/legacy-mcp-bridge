// Frozen non-model baseline: regex routing plus templates over the bridge. No question ids, oracle truth or held-out file access.
import { extractScriptedAnswer, SCRIPTED_LABEL, type ScriptedPolicy } from "../policy.ts";
import type { Answer } from "../answerSchema.ts";
import type { Condition } from "./types.ts";
type Route = Omit<ScriptedPolicy, "label" | "question_id" | "condition">;
export function routeQuestion(prompt: string): Route | null {
  if (/^(Close account|Post a debit|Update the name)/i.test(prompt)) return { tool: null, args: {}, kind: "refusal", path: "" };
  const history = /^(?:What is the (debit|credit) total in minor units|How many transactions are there) for account ([0-9]{10}) from ([0-9-]{10}) to ([0-9-]{10})\?$/.exec(prompt);
  if (history !== null) return { tool: "transactions_list", args: { account_id: history[2], from: history[3], to: history[4], limit: 100 }, kind: history[1] === undefined ? "count" : "sum", path: history[1] === undefined ? "matched_count" : `${history[1]}_total_minor` };
  const account = /^What is the (balance in minor units|open date|monthly interest in minor units|name|status|credit limit in minor units|rate in thousandths) for account ([0-9]{10})\?$/.exec(prompt);
  if (account !== null) {
    const fields: Record<string, string> = { "balance in minor units": "balance_minor", "open date": "open_date", "monthly interest in minor units": "monthly_interest_minor", name: "name.text", status: "status", "credit limit in minor units": "credit_limit_minor", "rate in thousandths": "rate_thousandths" };
    return { tool: "account_get", args: { account_id: account[2] }, kind: "value", path: `data.${fields[account[1] ?? ""] ?? ""}` };
  }
  const search = /^(How many accounts have|What is the balance total in minor units for accounts with|List account ids with) status ([ASC])(?: and name prefix ([A-Z ]+?))?(?: in physical order\.|\?)$/.exec(prompt);
  if (search !== null) return { tool: "accounts_find", args: { status: search[2], ...(search[3] === undefined ? {} : { name_prefix: search[3] }), limit: 50 }, kind: search[1]?.startsWith("List") ? "list" : search[1]?.startsWith("How") ? "count" : "sum", path: search[1]?.startsWith("List") ? "data" : search[1]?.startsWith("How") ? "matched_count" : "balance_total_minor" };
  const layout = /^(?:What is the record length of|How many fields are in|How many complete physical records were read in) (ACCTMSTR|TRANS)\?$/.exec(prompt);
  if (layout !== null) return { tool: "describe_layouts", args: {}, kind: prompt.startsWith("What") ? "value" : "count", path: `data.layouts[record=${layout[1]}].${prompt.startsWith("What") ? "record_length" : prompt.startsWith("How many fields") ? "fields" : "diagnostics.records_read"}` };
  const aging = /^What is the global aging amount(?: total)? in minor units(?: in bucket (0|1-30|31-60|61-90|>90))? as of ([0-9-]{10})\?$/.exec(prompt);
  if (aging !== null) return { tool: "aging_summary", args: { as_of: aging[2] }, kind: "sum", path: aging[1] === undefined ? "total_amount_minor" : `data.buckets[bucket=${aging[1]}].amount_minor` };
  const count = /^How many global aging transactions are there as of ([0-9-]{10})\?$/.exec(prompt);
  if (count !== null) return { tool: "aging_summary", args: { as_of: count[1] }, kind: "count", path: "total_count" };
  return null;
}
export async function runRouter(prompt: string, bridge: Condition): Promise<{ answer: Answer | null; failure: string | null; toolCalls: number }> {
  const route = routeQuestion(prompt);
  if (route === null) return { answer: null, failure: "router_abstention", toolCalls: 0 };
  if (route.tool === null) return { answer: { status: "refusal" }, failure: null, toolCalls: 0 };
  try {
    const result = await bridge.call(route.tool, route.args);
    const policy: ScriptedPolicy = { ...route, label: SCRIPTED_LABEL, question_id: "DEV00", condition: "A" };
    return { answer: extractScriptedAnswer(policy, result), failure: null, toolCalls: 1 };
  } catch { return { answer: null, failure: "router_error", toolCalls: 1 }; }
}
