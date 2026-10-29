// Known Wilson 95% values, endpoints and an explicit empty-denominator result.
import { describe, expect, it } from "vitest";
import { wilson } from "../../lib/evalkit/wilson.ts";

describe("Wilson 95% interval", () => {
  it("matches known 0/10, 5/10 and 10/10 intervals", () => {
    expect(wilson(0, 10)?.low).toBeCloseTo(0, 12);
    expect(wilson(0, 10)?.high).toBeCloseTo(0.2775328, 6);
    expect(wilson(5, 10)?.low).toBeCloseTo(0.2365931, 6);
    expect(wilson(5, 10)?.high).toBeCloseTo(0.7634069, 6);
    expect(wilson(10, 10)?.low).toBeCloseTo(0.7224672, 6);
    expect(wilson(10, 10)?.high).toBeCloseTo(1, 12);
  });
  it("returns null for no trials and rejects invalid counts", () => {
    expect(wilson(0, 0)).toBeNull();
    for (const [success, total] of [[-1, 10], [11, 10], [1.5, 10], [0, -1]]) expect(() => wilson(success ?? -1, total ?? -1)).toThrow();
  });
});
