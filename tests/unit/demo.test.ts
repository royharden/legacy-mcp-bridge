// This seam tests orchestration only; it makes no claim that MCP, oracle, parity or scripted integration has executed.
import { describe, expect, it } from "vitest";
import { runDemoSteps } from "../../scripts/demo.ts";

describe("demo orchestration", () => {
  it("runs named steps in order and preserves each claim/status", async () => {
    const order: string[] = [];
    const emitted: string[] = [];
    const steps = ["stdio", "projection", "scripted_refusal"].map((name) => ({
      name, claim: `test callback ${name}`, run: async () => {
        order.push(name);
        return { passed: true, detail: name === "scripted_refusal" ? "typed refusal; never lookup success" : "test callback completed" };
      },
    }));
    const result = await runDemoSteps(steps, (message) => emitted.push(message));
    expect(order).toEqual(["stdio", "projection", "scripted_refusal"]);
    expect(result.map((r) => r.name)).toEqual(order);
    expect(result[2]?.detail).toContain("typed refusal");
    expect(emitted).toHaveLength(3);
  });

  it("stops immediately on a failed verdict or thrown infrastructure error", async () => {
    let later = false;
    await expect(runDemoSteps([
      { name: "bad", claim: "failing test callback", run: async () => ({ passed: false, detail: "unexplained diff" }) },
      { name: "later", claim: "must not execute", run: async () => { later = true; return { passed: true, detail: "wrong" }; } },
    ])).rejects.toThrow(/demo step failed: bad/);
    expect(later).toBe(false);
    const outage = new Error("test infrastructure failure");
    await expect(runDemoSteps([{ name: "throw", claim: "exception control", run: async () => { throw outage; } }])).rejects.toBe(outage);
  });

  it("rejects an empty or ambiguously named journey", async () => {
    await expect(runDemoSteps([])).rejects.toThrow(/nonempty/);
    const step = { name: "duplicate", claim: "test callback", run: async () => ({ passed: true, detail: "test" }) };
    await expect(runDemoSteps([step, step])).rejects.toThrow(/uniquely named/);
  });
});
