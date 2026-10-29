// Provider-neutral sequential messages/replies. Both scripted fixtures and live output cross this validated boundary.
import { z } from "zod";

export const SCRIPTED_LABEL = "SCRIPTED FIXTURE — not a model result";
export type Usage = { inputTokens: number; outputTokens: number };
export type ToolCall = { id: string; name: string; arguments: unknown };
export type ToolDefinition = { name: string; description: string; input_schema: Record<string, unknown> };
export type ProviderMessage = { role: "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolCalls?: ToolCall[] };
export type ProviderRequest = {
  system: string; messages: ProviderMessage[]; tools: ToolDefinition[]; maxOutputTokens: number;
  model: string; temperature: 0; signal?: AbortSignal;
};
export type ProviderReply = { toolCalls: ToolCall[]; final: unknown | null; usage: Usage; label: string };
export type Provider = { mode: "mock" | "live"; complete(request: ProviderRequest): Promise<ProviderReply> };
export type PriceConfig = {
  status: "pinned" | "pending"; model: string | null; inputUsdPerMillion: number | null; outputUsdPerMillion: number | null;
  sourceUrl: string; checkedAt: string | null;
};

export const UsageSchema = z.object({ inputTokens: z.number().int().nonnegative().safe(), outputTokens: z.number().int().nonnegative().safe() }).strict();
const ToolCallSchema = z.object({ id: z.string().min(1), name: z.string().min(1), arguments: z.unknown() }).strict();
export const ProviderReplySchema = z.object({
  toolCalls: z.array(ToolCallSchema), final: z.unknown(), usage: UsageSchema, label: z.string().min(1),
}).strict().superRefine((reply, ctx) => {
  if (reply.final === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "final must be explicit (null for tool calls)" });
  if (reply.toolCalls.length > 0 && reply.final !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "tool calls and a final answer are mutually exclusive" });
  if (new Set(reply.toolCalls.map((c) => c.id)).size !== reply.toolCalls.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate tool-call id" });
});

export function validateRequest(request: ProviderRequest): void {
  if (typeof request.system !== "string" || !Array.isArray(request.messages) || !Array.isArray(request.tools) ||
    !request.model || request.temperature !== 0 || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 1024) {
    throw new Error("invalid provider request or output-token ceiling");
  }
  for (const message of request.messages) {
    if (!["user", "assistant", "tool"].includes(message.role) || typeof message.content !== "string" ||
      (message.role === "tool" && !message.toolCallId) || (message.role !== "assistant" && message.toolCalls !== undefined)) throw new Error("invalid provider message");
    if (message.toolCalls !== undefined) for (const call of message.toolCalls) ToolCallSchema.parse(call);
  }
  const names = new Set<string>();
  for (const tool of request.tools) {
    if (!tool.name || typeof tool.description !== "string" || typeof tool.input_schema !== "object" || tool.input_schema === null || names.has(tool.name)) throw new Error("invalid or duplicate tool definition");
    names.add(tool.name);
  }
  // Fail early on cyclic/non-JSON request state; the signal is a local execution control, never provider input.
  JSON.stringify({ ...request, signal: undefined });
}

export function validatePinnedPrices(prices: PriceConfig, model?: string): asserts prices is PriceConfig & {
  status: "pinned"; model: string; inputUsdPerMillion: number; outputUsdPerMillion: number; checkedAt: string;
} {
  if (prices.status !== "pinned" || !prices.model || (model !== undefined && prices.model !== model) ||
    typeof prices.inputUsdPerMillion !== "number" || !Number.isFinite(prices.inputUsdPerMillion) || prices.inputUsdPerMillion < 0 ||
    typeof prices.outputUsdPerMillion !== "number" || !Number.isFinite(prices.outputUsdPerMillion) || prices.outputUsdPerMillion < 0 ||
    prices.inputUsdPerMillion + prices.outputUsdPerMillion <= 0 || !/^https:\/\//.test(prices.sourceUrl) ||
    prices.checkedAt === null || !/^\d{4}-\d{2}-\d{2}$/.test(prices.checkedAt)) throw new Error("live model/prices are pending or invalid; activation must pin model, prices, source and date");
}

/** UTF-8 request bytes bound text tokens conservatively, plus an explicit framing/tool-definition allowance.
 * This deliberately overestimates; native usage must never be substituted before reserving an attempt.
 */
export function conservativeInputTokens(request: ProviderRequest): number {
  validateRequest(request);
  const bound = Buffer.byteLength(JSON.stringify({ ...request, signal: undefined }), "utf8") + 4096;
  if (!Number.isSafeInteger(bound)) throw new Error("provider input bound is too large");
  return bound;
}
