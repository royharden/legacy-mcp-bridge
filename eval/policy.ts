// Scripted fixtures replay explicit tool/extraction recipes; all replies cross the same provider validation boundary.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createMockProvider } from "../lib/providers/mock.ts";
import { SCRIPTED_LABEL, type Provider, type ProviderReply } from "../lib/providers/types.ts";
import { AnswerSchema, type Answer } from "./answerSchema.ts";
export { SCRIPTED_LABEL } from "../lib/providers/types.ts";
export const PolicySchema = z.object({
  label: z.literal(SCRIPTED_LABEL), question_id: z.string().regex(/^DEV[0-9]{2}$/), condition: z.literal("A"),
  tool: z.string().nullable(), args: z.record(z.unknown()),
  kind: z.enum(["value", "count", "sum", "list", "refusal"]), path: z.string(),
}).strict();
export type ScriptedPolicy = z.output<typeof PolicySchema>;

/** An intentionally tiny path language, declared in frozen policies; no eval or dynamic execution. */
export function atPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const token of path.split(".")) {
    const selector = /^([^[]+)\[([^=]+)=([^\]]+)\]$/.exec(token);
    if (selector !== null) {
      if (typeof cursor !== "object" || cursor === null) throw new Error("policy selector is not an object");
      const array = (cursor as Record<string, unknown>)[selector[1] ?? ""];
      if (!Array.isArray(array)) throw new Error("policy selector is not an array");
      cursor = array.find((entry: unknown) => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)[selector[2] ?? ""] === selector[3]);
    } else {
      if (typeof cursor !== "object" || cursor === null) throw new Error("missing policy path");
      cursor = (cursor as Record<string, unknown>)[token];
    }
  }
  return cursor;
}
export function collectSources(value: unknown): string[] {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string" && /^(ACCTMSTR|TRANS)#[1-9][0-9]*$/.test(v)) out.add(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(visit);
  };
  visit(value); return [...out];
}
export function extractScriptedAnswer(policy: ScriptedPolicy, result: unknown): Answer {
  if (policy.kind === "refusal") return { status: "refusal" };
  if (typeof result !== "object" || result === null) return { status: "error" };
  const r = result as Record<string, unknown>;
  if (r.ok !== true) {
    const error = r.error as Record<string, unknown> | undefined;
    return error?.code === "not_found" ? { status: "not_found" } : { status: "error" };
  }
  const data = r.structured;
  let value = atPath(data, policy.path);
  // Layout field count is the array length; other values already are typed tool scalars.
  if (policy.kind === "count" && Array.isArray(value)) value = value.length;
  const bucket = /^(data\.buckets\[bucket=[^\]]+\])\./.exec(policy.path)?.[1];
  const sources = collectSources(bucket === undefined ? data : atPath(data, bucket));
  if (policy.kind === "list") {
    if (!Array.isArray(value)) throw new Error("list policy needs rows");
    return AnswerSchema.parse({ status: "answer", kind: "list", account_ids: value.map((row: unknown) => (row as Record<string, unknown>).account_id), sources });
  }
  return AnswerSchema.parse({ status: "answer", kind: policy.kind, value, sources });
}
export function loadScriptedPolicy(questionId: string, root: string): ScriptedPolicy {
  if (!/^DEV[0-9]{2}$/.test(questionId)) throw new Error("scripted policies are development fixtures only");
  const policy = PolicySchema.parse(JSON.parse(readFileSync(join(root, "policies", `${questionId}.json`), "utf8")));
  if (policy.question_id !== questionId) throw new Error("policy/question mismatch");
  return policy;
}
export function createScriptedProvider(policy: ScriptedPolicy): Provider {
  let requested = false;
  return { mode: "mock", async complete(request): Promise<ProviderReply> {
    let reply: ProviderReply;
    if (!requested && policy.tool !== null) {
      requested = true;
      reply = { toolCalls: [{ id: "scripted-1", name: policy.tool, arguments: policy.args }], final: null, usage: { inputTokens: 0, outputTokens: 0 }, label: SCRIPTED_LABEL };
    } else {
      const last = request.messages.filter((message) => message.role === "tool").at(-1);
      const final = policy.kind === "refusal" ? { status: "refusal" } : extractScriptedAnswer(policy, last === undefined ? null : JSON.parse(last.content));
      reply = { toolCalls: [], final, usage: { inputTokens: 0, outputTokens: 0 }, label: SCRIPTED_LABEL };
    }
    return createMockProvider({ label: SCRIPTED_LABEL, steps: [reply] }).complete(request);
  } };
}
