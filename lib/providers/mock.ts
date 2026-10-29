// A named scripted fixture, never a model result. Each question gets its own sequential provider instance.
import { ProviderReplySchema, SCRIPTED_LABEL, validateRequest, type Provider, type ProviderReply } from "./types.ts";

export type ScriptedPolicy = { label: typeof SCRIPTED_LABEL; steps: ProviderReply[] };

export function createMockProvider(policy: ScriptedPolicy): Provider {
  if (policy.label !== SCRIPTED_LABEL || !Array.isArray(policy.steps) || policy.steps.length === 0) throw new Error("mock policy must be a named SCRIPTED FIXTURE with steps");
  const steps = policy.steps.map((step) => {
    const parsed = ProviderReplySchema.parse(step);
    if (parsed.label !== SCRIPTED_LABEL) throw new Error("every mock reply must carry the SCRIPTED FIXTURE label");
    return structuredClone(parsed) as ProviderReply;
  });
  let index = 0;
  return { mode: "mock", async complete(request) {
    validateRequest(request);
    if (request.signal?.aborted) throw new Error("scripted request aborted");
    const next = steps[index++];
    if (next === undefined) throw new Error("scripted fixture exhausted; no fabricated response");
    return structuredClone(next);
  } };
}
