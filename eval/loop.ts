// Sequential bounded model/tool loop. Every live attempt, including retries and unknown outcomes, passes the persistent ledger.
import { conservativeInputTokens, type CallLedger } from "../lib/callledger.ts";
import type { Provider, ProviderMessage, ProviderReply, ProviderRequest } from "../lib/providers/types.ts";
import type { Condition } from "./conditions/types.ts";
export type Limits = { toolCalls: number; rawBytes: number; maxOutputTokens: number; outputTokens: number; inputTokens: number; seconds: number; retries: number };
export type LoopResult = {
  answer: unknown; failure: string | null; forbiddenCalls: number; toolCalls: number; dispatchedTools: number; rawBytes: number;
  attempts: number; usage: { inputTokens: number; outputTokens: number; unknownAttempts: number; unknownInputBound: number; unknownOutputBound: number };
  latencyMs: number | null; label: string;
};
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
export async function runLoop(options: { prompt: string; condition: Condition; provider: Provider; model: string; limits: Limits; ledger?: CallLedger; now?: () => number }): Promise<LoopResult> {
  const { condition, provider, limits } = options;
  if (provider.mode === "live" && options.ledger === undefined) throw new Error("live loop requires a persistent ledger");
  for (const [key, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value < (key === "retries" ? 0 : 1)) throw new Error(`invalid limit ${key}`);
  const now = options.now ?? Date.now;
  const started = now();
  const state: LoopResult = { answer: null, failure: null, forbiddenCalls: 0, toolCalls: 0, dispatchedTools: 0, rawBytes: 0, attempts: 0,
    usage: { inputTokens: 0, outputTokens: 0, unknownAttempts: 0, unknownInputBound: 0, unknownOutputBound: 0 }, latencyMs: null, label: provider.mode === "mock" ? "SCRIPTED FIXTURE — not a model result" : "live model" };
  const messages: ProviderMessage[] = [{ role: "user", content: options.prompt }];
  const finish = (failure: string | null): LoopResult => { state.failure = failure; state.latencyMs = provider.mode === "live" ? now() - started : null; return state; };
  const expired = (): boolean => now() - started >= limits.seconds * 1000;
  // Each successful round must consume output tokens or tool calls; empty replies fail immediately.
  while (true) {
    if (expired()) return finish("time_exhausted");
    const outputRemaining = limits.outputTokens - state.usage.outputTokens - state.usage.unknownOutputBound;
    if (outputRemaining <= 0) return finish("output_tokens_exhausted");
    const controller = new AbortController();
    const request: ProviderRequest = { system: condition.system, messages: [...messages], tools: condition.tools, maxOutputTokens: Math.min(limits.maxOutputTokens, outputRemaining), model: options.model, temperature: 0, signal: controller.signal };
    const inputBound = conservativeInputTokens(request);
    if (state.usage.inputTokens + state.usage.unknownInputBound + inputBound > limits.inputTokens) return finish("input_tokens_exhausted");
    let reply: ProviderReply | null = null;
    for (let retry = 0; retry <= limits.retries; retry += 1) {
      if (expired()) return finish("time_exhausted");
      if (state.usage.inputTokens + state.usage.unknownInputBound + inputBound > limits.inputTokens) return finish("input_tokens_exhausted");
      if (state.usage.outputTokens + state.usage.unknownOutputBound + request.maxOutputTokens > limits.outputTokens) return finish("output_tokens_exhausted");
      let reservation: ReturnType<CallLedger["reserve"]> | undefined;
      if (provider.mode === "live") {
        try { reservation = options.ledger?.reserve({ model: options.model, inputTokenBound: inputBound, maxOutputTokens: request.maxOutputTokens }); }
        catch (error) { return finish(/budget|cap|remaining/i.test(reason(error)) ? "budget_exhausted" : "ledger_error"); }
      }
      state.attempts += 1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remainingMs = Math.max(1, limits.seconds * 1000 - (now() - started));
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("question timeout")); }, remainingMs); });
        reply = await Promise.race([provider.complete(request), timeout]);
      } catch {
        if (reservation !== undefined) options.ledger?.settle(reservation.id, { status: "unknown" });
        state.usage.unknownAttempts += 1;
        state.usage.unknownInputBound += inputBound;
        state.usage.unknownOutputBound += request.maxOutputTokens;
        if (expired() || controller.signal.aborted) return finish("time_exhausted");
        if (retry === limits.retries) return finish("provider_error");
        continue;
      } finally { if (timer !== undefined) clearTimeout(timer); }
      if (reservation !== undefined) options.ledger?.settle(reservation.id, { status: "known", usage: reply.usage });
      state.usage.inputTokens += reply.usage.inputTokens;
      state.usage.outputTokens += reply.usage.outputTokens;
      break;
    }
    if (reply === null) return finish("provider_error");
    if (state.usage.inputTokens + state.usage.unknownInputBound > limits.inputTokens) return finish("input_tokens_exhausted");
    if (reply.usage.outputTokens > request.maxOutputTokens || state.usage.outputTokens + state.usage.unknownOutputBound > limits.outputTokens) return finish("output_tokens_exhausted");
    if (expired()) return finish("time_exhausted");
    const allowed = new Set(condition.tools.map((tool) => tool.name));
    // Count every attempted unknown call even when a batch already exhausts the resource allowance.
    state.forbiddenCalls += reply.toolCalls.filter((call) => !allowed.has(call.name)).length;
    state.toolCalls += reply.toolCalls.length;
    if (state.toolCalls > limits.toolCalls) return finish("tool_calls_exhausted");
    if (reply.final !== null) {
      if (reply.toolCalls.length > 0) return finish("ambiguous_provider_reply");
      state.answer = reply.final; return finish(null);
    }
    if (reply.toolCalls.length === 0) return finish("empty_provider_reply");
    messages.push({ role: "assistant", content: "", toolCalls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      if (expired()) return finish("time_exhausted");
      if (!allowed.has(call.name)) {
        messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify({ ok: false, error: { code: "unknown_tool", message: "only the condition's read-only tools are available" } }) });
        continue;
      }
      let result;
      if ((condition.id === "C2" || condition.id === "C") && typeof call.arguments === "object" && call.arguments !== null) {
        const args = call.arguments as Record<string, unknown>;
        const rawBound = call.name === "read_range" && typeof args.length === "number" ? args.length
          : call.name === "grep" && typeof args.max_matches === "number" && typeof args.literal === "string" ? args.max_matches * (Buffer.byteLength(args.literal, "latin1") + 80) : 0;
        if (Number.isSafeInteger(rawBound) && rawBound > limits.rawBytes - state.rawBytes) return finish("raw_bytes_exhausted");
      }
      try { state.dispatchedTools += 1; result = await condition.call(call.name, call.arguments); }
      catch { return finish("tool_error"); }
      if (result.ok) {
        state.rawBytes += result.rawBytes ?? 0;
        if (state.rawBytes > limits.rawBytes) return finish("raw_bytes_exhausted");
      }
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
    }
  }
}
