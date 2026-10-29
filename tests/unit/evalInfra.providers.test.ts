// Provider boundary controls: scripted fixtures, missing live prerequisites and conservative request accounting only.
import { describe, expect, it, vi } from "vitest";
import { createAnthropicProvider } from "../../lib/providers/anthropic.ts";
import { createMockProvider } from "../../lib/providers/mock.ts";
import { conservativeInputTokens, ProviderReplySchema, SCRIPTED_LABEL, type PriceConfig, type ProviderRequest } from "../../lib/providers/types.ts";

const request: ProviderRequest = { system: "system", messages: [{ role: "user", content: "question" }], tools: [], maxOutputTokens: 100, model: "fixture", temperature: 0 };
const prices: PriceConfig = { status: "pinned", model: "fixture", inputUsdPerMillion: 1, outputUsdPerMillion: 2,
  sourceUrl: "https://example.invalid/prices", checkedAt: "2026-10-24" };

describe("provider boundary", () => {
  it("replays explicitly labelled steps through the shared reply boundary and never fabricates extra steps", async () => {
    const mock = createMockProvider({ label: SCRIPTED_LABEL, steps: [
      { toolCalls: [{ id: "call1", name: "account_get", arguments: { account_id: "0000000042" } }], final: null, usage: { inputTokens: 0, outputTokens: 0 }, label: SCRIPTED_LABEL },
      { toolCalls: [], final: { status: "answer", value: -123456 }, usage: { inputTokens: 0, outputTokens: 0 }, label: SCRIPTED_LABEL },
    ] });
    expect((await mock.complete(request)).toolCalls[0]?.name).toBe("account_get");
    expect((await mock.complete(request)).final).toEqual({ status: "answer", value: -123456 });
    await expect(mock.complete(request)).rejects.toThrow(/exhausted/);
    expect(() => ProviderReplySchema.parse({ toolCalls: [], final: {}, usage: { inputTokens: -1, outputTokens: 0 }, label: SCRIPTED_LABEL })).toThrow();
    expect(() => ProviderReplySchema.parse({ toolCalls: [{ id: "x", name: "t", arguments: {} }], final: {}, usage: { inputTokens: 0, outputTokens: 0 }, label: SCRIPTED_LABEL })).toThrow(/mutually exclusive/);
  });

  it("requires pinned live configuration and an environment key before any SDK import/call", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    try {
      expect(() => createAnthropicProvider({ model: "fixture", prices: { ...prices, status: "pending" } })).toThrow(/pending/);
      expect(() => createAnthropicProvider({ model: "fixture", prices })).toThrow(/ANTHROPIC_API_KEY is missing/);
    } finally { vi.unstubAllEnvs(); }
  });

  it("bounds the entire UTF-8 request including tool schemas and message history, with framing allowance", () => {
    const input = { ...request, system: "é".repeat(200), tools: [{ name: "tool", description: "description", input_schema: { type: "object", properties: { x: { type: "string" } } } }] };
    expect(conservativeInputTokens(input)).toBe(Buffer.byteLength(JSON.stringify(input), "utf8") + 4096);
    expect(conservativeInputTokens(input)).toBeGreaterThan(conservativeInputTokens(request));
    expect(() => conservativeInputTokens({ ...request, maxOutputTokens: 1025 })).toThrow(/ceiling/);
  });
});
