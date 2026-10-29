// Ledger controls use temporary original files; no provider, server, oracle, generator or real credentials.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openLedger } from "../../lib/callledger.ts";
import type { PriceConfig } from "../../lib/providers/types.ts";

const prices: PriceConfig = { status: "pinned", model: "test-model", inputUsdPerMillion: 1, outputUsdPerMillion: 2,
  sourceUrl: "https://example.invalid/prices", checkedAt: "2026-10-24" };
const attempt = { model: "test-model", inputTokenBound: 1000, maxOutputTokens: 100 };
const dir = (): string => mkdtempSync(join(tmpdir(), "lmb-ledger-"));

describe("persistent whole-eval ledger", () => {
  it("refuses before an over-budget attempt and reconciles known usage without freeing unknown usage", () => {
    const resultsDir = dir();
    const ledger = openLedger({ resultsDir, runId: "run1", budgetUsd: 0.002, prices });
    try {
      const first = ledger.reserve(attempt);
      expect(first.projectedUsd).toBeCloseTo(0.0012, 10);
      const before = readFileSync(join(resultsDir, "runs", "run1", "ledger.jsonl"), "utf8");
      expect(() => ledger.reserve(attempt)).toThrow(/before provider attempt/);
      expect(readFileSync(join(resultsDir, "runs", "run1", "ledger.jsonl"), "utf8")).toBe(before);
      ledger.settle(first.id, { status: "known", usage: { inputTokens: 100, outputTokens: 50 } });
      expect(ledger.snapshot().knownUsd).toBeCloseTo(0.0002, 10);
      const second = ledger.reserve(attempt);
      ledger.settle(second.id, { status: "unknown" });
      expect(ledger.snapshot().chargedUsd).toBeCloseTo(0.0014, 10);
      expect(ledger.snapshot().unknownUsd).toBeCloseTo(0.0012, 10);
      expect(() => ledger.settle(second.id, { status: "known", usage: { inputTokens: 0, outputTokens: 0 } })).toThrow(/already settled/);
    } finally { ledger.close(); }
    const restart = openLedger({ resultsDir, runId: "run2", budgetUsd: 0.002, prices });
    try {
      expect(restart.snapshot().chargedUsd).toBeCloseTo(0.0014, 10);
      expect(() => restart.reserve(attempt)).toThrow(/budget exhausted/);
    } finally { restart.close(); }
  });

  it("each retry and a process restart retains unsettled projections; caps cannot silently increase", () => {
    const resultsDir = dir();
    const ledger = openLedger({ resultsDir, runId: "attempts", budgetUsd: 0.004, prices });
    try {
      const a = ledger.reserve(attempt);
      ledger.settle(a.id, { status: "unknown" });
      const b = ledger.reserve(attempt);
      ledger.settle(b.id, { status: "unknown" });
      const c = ledger.reserve(attempt); // simulated crash after dispatch, without a settlement
      expect(new Set([a.id, b.id, c.id]).size).toBe(3);
      expect(ledger.snapshot().unknownUsd).toBeCloseTo(0.0036, 10);
    } finally { ledger.close(); }
    expect(() => openLedger({ resultsDir, runId: "raise", budgetUsd: 0.01, prices })).toThrow(/cap reset/);
    const restarted = openLedger({ resultsDir, runId: "restart", budgetUsd: 0.004, prices });
    try {
      expect(restarted.snapshot().unknownUsd).toBeCloseTo(0.0036, 10);
      expect(() => restarted.reserve(attempt)).toThrow(/budget exhausted/);
    } finally { restarted.close(); }
  });

  it("holds an exclusive guard with ownership fields and never clears stale/changed guards", () => {
    const resultsDir = dir();
    const lock = join(resultsDir, ".ledger.lock");
    const ledger = openLedger({ resultsDir, runId: "owner", budgetUsd: 1, prices });
    const bytes = readFileSync(lock, "utf8");
    const guard = JSON.parse(bytes) as Record<string, unknown>;
    expect(guard).toMatchObject({ run_id: "owner", pid: process.pid, ledger_path: join(resultsDir, "runs", "owner", "ledger.jsonl") });
    expect(typeof guard.start_time).toBe("string");
    expect(() => openLedger({ resultsDir, runId: "other", budgetUsd: 1, prices })).toThrow(/verify no owner is active/);
    expect(readFileSync(lock, "utf8")).toBe(bytes);
    writeFileSync(lock, "replacement owner\n");
    expect(() => ledger.reserve(attempt)).toThrow(/ownership changed/);
    ledger.close();
    expect(readFileSync(lock, "utf8")).toBe("replacement owner\n");
    expect(() => openLedger({ resultsDir, runId: "again", budgetUsd: 1, prices })).toThrow(/never auto-deleted/);
  });

  it("rejects malformed/truncated persisted history instead of skipping it and preserves original bytes", () => {
    for (const corruption of ["bad-json", "truncated", "duplicate", "wrong-charge"]) {
      const resultsDir = dir();
      const ledger = openLedger({ resultsDir, runId: "old", budgetUsd: 1, prices });
      ledger.reserve(attempt);
      ledger.close();
      const path = join(resultsDir, "runs", "old", "ledger.jsonl");
      const text = readFileSync(path, "utf8");
      let broken = text;
      if (corruption === "bad-json") broken += "not json\n";
      else if (corruption === "truncated") broken = text.slice(0, -1);
      else if (corruption === "duplicate") broken += (text.trimEnd().split("\n")[1] ?? "") + "\n";
      else broken = text.replace('"projected_nano_usd":1200000', '"projected_nano_usd":1');
      expect(broken).not.toBe(text);
      writeFileSync(path, broken);
      expect(() => openLedger({ resultsDir, runId: "new", budgetUsd: 1, prices })).toThrow();
      expect(readFileSync(path, "utf8")).toBe(broken);
      expect(existsSync(join(resultsDir, ".ledger.lock"))).toBe(false);
    }
  });

  it("rejects pending pricing, bad bounds, mismatched models and double settlement", () => {
    expect(() => openLedger({ resultsDir: dir(), runId: "pending", budgetUsd: 1, prices: { ...prices, status: "pending" } })).toThrow(/pending/);
    const ledger = openLedger({ resultsDir: dir(), runId: "validation", budgetUsd: 1, prices });
    try {
      expect(() => ledger.reserve({ ...attempt, inputTokenBound: -1 })).toThrow();
      expect(() => ledger.reserve({ ...attempt, model: "other" })).toThrow(/model differs/);
      const reservation = ledger.reserve(attempt);
      ledger.settle(reservation.id, { status: "known", usage: { inputTokens: 10, outputTokens: 5 } });
      expect(() => ledger.settle(reservation.id, { status: "unknown" })).toThrow(/already settled/);
    } finally { ledger.close(); }
  });
});
