// Safety/resource regressions for the provider loop, with in-memory providers/ledger; never invokes the SDK or oracle.
import { describe, expect, it } from "vitest";
import { runLoop, type Limits } from "../../eval/loop.ts";
import type { Condition } from "../../eval/conditions/types.ts";
import type { CallLedger, Settlement } from "../../lib/callledger.ts";
import type { Provider, ProviderReply } from "../../lib/providers/types.ts";
const limits: Limits = { toolCalls: 8, rawBytes: 1048576, maxOutputTokens: 1024, outputTokens: 12288, inputTokens: 40000, seconds: 900, retries: 2 };
const final: ProviderReply = { toolCalls: [], final: { status: "refusal" }, usage: { inputTokens: 10, outputTokens: 5 }, label: "test" };
function bridge(onCall: (name: string) => void = () => {}): Condition {
  return { id: "A", system: "read-only", fixtureDigest: "literal", tools: [{ name: "account_get", description: "read only", input_schema: { type: "object" } }], async call(name) { onCall(name); return { ok: true, structured: {}, text: "{}" }; } };
}
function ledger(refuse = false): { value: CallLedger; events: string[]; settlements: Settlement[] } {
  const events: string[] = [], settlements: Settlement[] = [];
  return { events, settlements, value: {
    reserve() { events.push("reserve"); if (refuse) throw new Error("live budget exhausted before provider attempt"); return { id: String(events.length), projectedUsd: 0.01 }; },
    settle(id, settlement) { events.push(`settle:${id}`); settlements.push(settlement); return { chargedUsd: 0.01, status: settlement.status }; },
    snapshot() { return { chargedUsd: 0, knownUsd: 0, unknownUsd: 0, remainingUsd: 5, reservations: 0 }; }, close() {},
  } };
}
describe("bounded provider loop", () => {
  it("refuses budget before calling a provider and reserves every retry", async () => {
    let calls = 0;
    const provider: Provider = { mode: "live", async complete() { calls += 1; throw new Error("unknown network outcome"); } };
    const blocked = ledger(true);
    expect((await runLoop({ prompt: "close", condition: bridge(), provider, model: "pinned", limits, ledger: blocked.value })).failure).toBe("budget_exhausted");
    expect(calls).toBe(0);
    const attempted = ledger();
    const result = await runLoop({ prompt: "close", condition: bridge(), provider, model: "pinned", limits, ledger: attempted.value });
    expect(result.failure).toBe("provider_error"); expect(result.attempts).toBe(3);
    expect(attempted.events.filter((event) => event === "reserve")).toHaveLength(3);
    expect(attempted.settlements).toEqual([{ status: "unknown" }, { status: "unknown" }, { status: "unknown" }]);
  });
  it("settles known usage and returns a typed final only after the reservation", async () => {
    const memory = ledger();
    const provider: Provider = { mode: "live", async complete() { memory.events.push("complete"); return final; } };
    const result = await runLoop({ prompt: "close", condition: bridge(), provider, model: "pinned", limits, ledger: memory.value });
    expect(memory.events).toEqual(["reserve", "complete", "settle:1"]);
    expect(memory.settlements).toEqual([{ status: "known", usage: final.usage }]);
    expect(result.answer).toEqual({ status: "refusal" });
  });
  it("counts all forbidden attempts in an oversized batch without dispatching any tool", async () => {
    const dispatched: string[] = [];
    const provider: Provider = { mode: "mock", async complete() { return { ...final, final: null, toolCalls: Array.from({ length: 9 }, (_, index) => ({ id: String(index), name: "account_post", arguments: {} })) }; } };
    const result = await runLoop({ prompt: "lookup", condition: bridge((name) => dispatched.push(name)), provider, model: "fixture", limits });
    expect(result.failure).toBe("tool_calls_exhausted"); expect(result.forbiddenCalls).toBe(9); expect(dispatched).toEqual([]);
  });
  it("unknown tools are refused, recorded for safety, and never forwarded to the bridge", async () => {
    let step = 0; const dispatched: string[] = [];
    const provider: Provider = { mode: "mock", async complete() { return step++ === 0 ? { ...final, final: null, toolCalls: [{ id: "bad", name: "account_post", arguments: {} }] } : final; } };
    const result = await runLoop({ prompt: "lookup", condition: bridge((name) => dispatched.push(name)), provider, model: "fixture", limits });
    expect(result.forbiddenCalls).toBe(1); expect(result.toolCalls).toBe(1); expect(dispatched).toEqual([]);
  });
  it("input exhaustion refuses before the provider, and raw-byte exhaustion refuses before the data call", async () => {
    let calls = 0, dispatched = 0;
    const provider: Provider = { mode: "mock", async complete() { calls += 1; return { ...final, final: null, toolCalls: [{ id: "range", name: "read_range", arguments: { file: "TRANS.DAT", offset: 0, length: 4096 } }] }; } };
    expect((await runLoop({ prompt: "lookup", condition: bridge(), provider, model: "fixture", limits: { ...limits, inputTokens: 1 } })).failure).toBe("input_tokens_exhausted");
    expect(calls).toBe(0);
    const raw: Condition = { ...bridge(), id: "C2", tools: [{ name: "read_range", description: "raw", input_schema: {} }], async call() { dispatched += 1; return { ok: true, structured: {}, text: "", rawBytes: 4096 }; } };
    expect((await runLoop({ prompt: "lookup", condition: raw, provider, model: "fixture", limits: { ...limits, rawBytes: 10 } })).failure).toBe("raw_bytes_exhausted");
    expect(dispatched).toBe(0);
  });
  it("a time ceiling and missing live ledger fail closed without a provider call", async () => {
    let calls = 0, tick = 0;
    const provider: Provider = { mode: "mock", async complete() { calls += 1; return final; } };
    expect((await runLoop({ prompt: "lookup", condition: bridge(), provider, model: "fixture", limits, now: () => tick++ === 0 ? 0 : 900000 })).failure).toBe("time_exhausted");
    expect(calls).toBe(0);
    await expect(runLoop({ prompt: "lookup", condition: bridge(), provider: { ...provider, mode: "live" }, model: "pinned", limits })).rejects.toThrow("persistent ledger");
  });
});
