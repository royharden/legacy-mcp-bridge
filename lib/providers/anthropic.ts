// Live-only optional SDK seam. Missing activation configuration/key fails explicitly; retries belong to the ledgered loop.
import { ProviderReplySchema, UsageSchema, validatePinnedPrices, validateRequest, type PriceConfig, type Provider, type ProviderMessage, type ProviderReply } from "./types.ts";

type LiveClient = { messages: { create(body: unknown, options: { signal?: AbortSignal }): Promise<unknown> } };

function messagesForSdk(messages: ProviderMessage[]): Array<{ role: "user" | "assistant"; content: unknown[] }> {
  const out: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content: unknown[] = message.role === "tool" ? [{
      type: "tool_result", tool_use_id: message.toolCallId, content: message.content,
    }] : [
      ...(message.content === "" ? [] : [{ type: "text", text: message.content }]),
      ...(message.toolCalls ?? []).map((call) => ({ type: "tool_use", id: call.id, name: call.name, input: call.arguments })),
    ];
    const previous = out[out.length - 1];
    if (previous?.role === role) previous.content.push(...content);
    else out.push({ role, content });
  }
  return out;
}

function parseReply(raw: unknown): ProviderReply {
  if (typeof raw !== "object" || raw === null) throw new Error("invalid live provider response");
  const reply = raw as Record<string, unknown>;
  if (!Array.isArray(reply.content) || typeof reply.usage !== "object" || reply.usage === null) throw new Error("live response missing content/usage");
  const usage = reply.usage as Record<string, unknown>;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const extra = [usage.cache_creation_input_tokens ?? 0, usage.cache_read_input_tokens ?? 0];
  if (typeof input !== "number" || typeof output !== "number" || extra.some((v) => typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)) throw new Error("invalid live token usage");
  const parsedUsage = UsageSchema.parse({ inputTokens: input + (extra[0] as number) + (extra[1] as number), outputTokens: output });
  const toolCalls: ProviderReply["toolCalls"] = [];
  const texts: string[] = [];
  for (const block of reply.content) {
    if (typeof block !== "object" || block === null) throw new Error("invalid live content block");
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
    else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") toolCalls.push({ id: b.id, name: b.name, arguments: b.input });
    else throw new Error("unsupported live content block");
  }
  let final: unknown = null;
  if (toolCalls.length === 0) {
    const text = texts.join("\n");
    try { final = JSON.parse(text); } catch { final = text; }
  }
  return ProviderReplySchema.parse({ toolCalls, final, usage: parsedUsage, label: "live model result" }) as ProviderReply;
}

export function createAnthropicProvider(options: { model: string; prices: PriceConfig }): Provider {
  validatePinnedPrices(options.prices, options.model);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey?.trim()) throw new Error("ANTHROPIC_API_KEY is missing; live evaluation cannot start");
  let client: Promise<LiveClient> | undefined;
  return { mode: "live", async complete(request) {
    validateRequest(request);
    if (request.model !== options.model) throw new Error("request model differs from activation-pinned model");
    if (request.signal?.aborted) throw new Error("live request aborted before provider attempt");
    client ??= import("@anthropic-ai/sdk").then((sdk) => {
      const Constructor = sdk.default as unknown as new (opts: { apiKey: string; maxRetries: number; timeout: number }) => LiveClient;
      return new Constructor({ apiKey, maxRetries: 0, timeout: 900000 });
    });
    const native = await client;
    const raw = await native.messages.create({
      model: options.model, system: request.system, messages: messagesForSdk(request.messages),
      tools: request.tools, temperature: 0, max_tokens: request.maxOutputTokens,
    }, request.signal === undefined ? {} : { signal: request.signal });
    return parseReply(raw);
  } };
}
