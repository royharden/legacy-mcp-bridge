// Exclusive whole-experiment spend ledger. Reserve durably before each attempt; unknown/unsettled attempts retain charge.
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { UsageSchema, validatePinnedPrices, type PriceConfig, type Usage } from "./providers/types.ts";
export { conservativeInputTokens } from "./providers/types.ts";

const Nano = z.number().int().nonnegative().safe();
const Positive = z.number().int().positive().safe();
const Prices = z.object({
  status: z.literal("pinned"), model: z.string().min(1), inputUsdPerMillion: z.number().nonnegative().finite(),
  outputUsdPerMillion: z.number().nonnegative().finite(), sourceUrl: z.string(), checkedAt: z.string(),
}).strict();
const Header = z.object({ version: z.literal(1), type: z.literal("run"), run_id: z.string(), start_time: z.string(), budget_nano_usd: Positive, prices: Prices }).strict();
const Reserve = z.object({
  version: z.literal(1), type: z.literal("reserve"), run_id: z.string(), id: z.string(), model: z.string(),
  inputTokenBound: Positive, maxOutputTokens: Positive, projected_nano_usd: Nano,
}).strict();
const Settle = z.object({
  version: z.literal(1), type: z.literal("settle"), run_id: z.string(), id: z.string(),
  status: z.enum(["known", "unknown"]), usage: UsageSchema.optional(), charged_nano_usd: Nano,
}).strict();
type ReservationState = { projected: number; charged: number; known: boolean; settled: boolean; runId: string; prices: PriceConfig };
export type Reservation = { id: string; projectedUsd: number };
export type LedgerSnapshot = { chargedUsd: number; knownUsd: number; unknownUsd: number; remainingUsd: number; reservations: number };
export type Settlement = { status: "known"; usage: Usage } | { status: "unknown" };
export type CallLedger = {
  reserve(input: { model: string; inputTokenBound: number; maxOutputTokens: number }): Reservation;
  settle(id: string, settlement: Settlement): { chargedUsd: number; status: "known" | "unknown" };
  snapshot(): LedgerSnapshot;
  close(): void;
};

function safeNanos(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("cost is not representable safely");
  return value;
}

function rateMicros(value: number): bigint {
  // Activation prices support six decimal USD digits per million tokens. Round upward, never under-reserve.
  const micros = Math.ceil(value * 1000000);
  return BigInt(safeNanos(micros));
}

function costNanos(usage: Usage, prices: PriceConfig): number {
  const valid = UsageSchema.parse(usage);
  validatePinnedPrices(prices);
  const numerator = BigInt(valid.inputTokens) * rateMicros(prices.inputUsdPerMillion) + BigInt(valid.outputTokens) * rateMicros(prices.outputUsdPerMillion);
  // One micro-USD per million tokens = 1/1000 nano-USD per token.
  return safeNanos(Number((numerator + 999n) / 1000n));
}

function durableAppend(path: string, value: unknown): void {
  const fd = openSync(path, "a", 0o600);
  try { writeSync(fd, JSON.stringify(value) + "\n", undefined, "utf8"); fsyncSync(fd); }
  finally { closeSync(fd); }
}

function history(runsDir: string): { states: Map<string, ReservationState>; caps: number[] } {
  const states = new Map<string, ReservationState>();
  const caps: number[] = [];
  if (!existsSync(runsDir)) return { states, caps };
  if (lstatSync(runsDir).isSymbolicLink() || !lstatSync(runsDir).isDirectory()) throw new Error("ledger runs path is not a plain directory");
  for (const runId of readdirSync(runsDir).sort()) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error("invalid persisted run directory name");
    const dir = join(runsDir, runId);
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error("persisted run is not a plain directory");
    const path = join(dir, "ledger.jsonl");
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`missing/unsafe persisted ledger for ${runId}`);
    const text = readFileSync(path, "utf8");
    if (!text.endsWith("\n")) throw new Error(`truncated persisted ledger for ${runId}`);
    const rows = text.slice(0, -1).split("\n").map((line) => JSON.parse(line) as unknown);
    const header = Header.parse(rows.shift());
    if (header.run_id !== runId) throw new Error("persisted run id mismatch");
    validatePinnedPrices(header.prices);
    caps.push(header.budget_nano_usd);
    let sequence = 0;
    for (const raw of rows) {
      if (typeof raw !== "object" || raw === null || !("type" in raw)) throw new Error("invalid persisted ledger row");
      if (raw.type === "reserve") {
        const row = Reserve.parse(raw);
        sequence++;
        if (row.run_id !== runId || row.id !== `${runId}:${sequence}` || row.model !== header.prices.model || states.has(row.id)) throw new Error("invalid persisted reservation identity");
        const expected = costNanos({ inputTokens: row.inputTokenBound, outputTokens: row.maxOutputTokens }, header.prices);
        if (row.projected_nano_usd !== expected) throw new Error("persisted reservation projection mismatch");
        states.set(row.id, { projected: expected, charged: expected, known: false, settled: false, runId, prices: header.prices });
      } else if (raw.type === "settle") {
        const row = Settle.parse(raw);
        const state = states.get(row.id);
        if (row.run_id !== runId || state === undefined || state.runId !== runId || state.settled) throw new Error("missing/duplicate persisted settlement");
        if ((row.status === "known") !== (row.usage !== undefined)) throw new Error("persisted settlement usage mismatch");
        const charge = row.status === "known" && row.usage !== undefined ? costNanos(row.usage, state.prices) : state.projected;
        if (row.charged_nano_usd !== charge) throw new Error("persisted settlement charge mismatch");
        state.charged = charge; state.known = row.status === "known"; state.settled = true;
      } else throw new Error("unknown persisted ledger event");
    }
  }
  return { states, caps };
}

export function openLedger(options: { resultsDir: string; runId: string; budgetUsd: number; prices: PriceConfig }): CallLedger {
  const prices = structuredClone(options.prices);
  const { runId } = options;
  validatePinnedPrices(prices);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId)) throw new Error("runId must be a safe new identifier");
  if (!Number.isFinite(options.budgetUsd) || options.budgetUsd <= 0) throw new Error("budgetUsd must be positive");
  const cap = safeNanos(Math.floor(options.budgetUsd * 1000000000));
  if (cap === 0) throw new Error("budget is below ledger precision");
  const resultsDir = resolve(options.resultsDir);
  mkdirSync(resultsDir, { recursive: true });
  if (lstatSync(resultsDir).isSymbolicLink()) throw new Error("results directory cannot be a symbolic link");
  const runsDir = join(resultsDir, "runs");
  const runDir = join(runsDir, runId);
  const ledgerPath = join(runDir, "ledger.jsonl");
  const lockPath = join(resultsDir, ".ledger.lock");
  const startTime = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const ownedBytes = JSON.stringify({ run_id: runId, pid: process.pid, start_time: startTime, ledger_path: ledgerPath }) + "\n";
  let fd: number;
  try { fd = openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") throw new Error(`ledger guard exists: ${lockPath}; inspect its run_id/pid/start_time/ledger_path and verify no owner is active before manually clearing it; never auto-deleted`);
    throw error;
  }
  try { writeSync(fd, ownedBytes, undefined, "utf8"); fsyncSync(fd); }
  finally { closeSync(fd); }
  let closed = false;
  const owned = (): boolean => existsSync(lockPath) && !lstatSync(lockPath).isSymbolicLink() && readFileSync(lockPath, "utf8") === ownedBytes;
  const assertOwned = (): void => { if (closed || !owned()) throw new Error("ledger guard is closed or ownership changed"); };
  const close = (): void => { if (!closed) { if (owned()) unlinkSync(lockPath); closed = true; } };
  try {
    const loaded = history(runsDir);
    if (loaded.caps.some((oldCap) => cap > oldCap)) throw new Error("budget increase across persisted runs requires an explicit reviewed activation change; refusing silent cap reset");
    if (existsSync(runDir)) throw new Error("runId already exists; choose a new id without removing old history");
    mkdirSync(runDir, { recursive: true });
    durableAppend(ledgerPath, { version: 1, type: "run", run_id: runId, start_time: startTime, budget_nano_usd: cap, prices });
    const states = loaded.states;
    let sequence = 0;
    const totals = (): { charged: number; known: number; unknown: number } => {
      let known = 0; let unknown = 0;
      for (const state of states.values()) {
        if (state.known) known = safeNanos(known + state.charged);
        else unknown = safeNanos(unknown + state.charged);
      }
      return { known, unknown, charged: safeNanos(known + unknown) };
    };
    return {
      reserve(input) {
        assertOwned();
        Positive.parse(input.inputTokenBound); Positive.parse(input.maxOutputTokens);
        if (input.model !== prices.model) throw new Error("reservation model differs from pinned price model");
        const projected = costNanos({ inputTokens: input.inputTokenBound, outputTokens: input.maxOutputTokens }, prices);
        if (totals().charged + projected > cap) throw new Error("live budget exhausted before provider attempt");
        const id = `${runId}:${sequence + 1}`;
        durableAppend(ledgerPath, { version: 1, type: "reserve", run_id: runId, id, ...input, projected_nano_usd: projected });
        sequence++;
        states.set(id, { projected, charged: projected, known: false, settled: false, runId, prices });
        return { id, projectedUsd: projected / 1000000000 };
      },
      settle(id, settlement) {
        assertOwned();
        const state = states.get(id);
        if (state === undefined || state.runId !== runId || state.settled) throw new Error("reservation missing, not owned, or already settled");
        if (settlement.status !== "known" && settlement.status !== "unknown") throw new Error("invalid settlement status");
        const charged = settlement.status === "known" ? costNanos(settlement.usage, prices) : state.projected;
        durableAppend(ledgerPath, { version: 1, type: "settle", run_id: runId, id, status: settlement.status,
          ...(settlement.status === "known" ? { usage: settlement.usage } : {}), charged_nano_usd: charged });
        state.charged = charged; state.known = settlement.status === "known"; state.settled = true;
        return { chargedUsd: charged / 1000000000, status: settlement.status };
      },
      snapshot() {
        assertOwned();
        const total = totals();
        return { chargedUsd: total.charged / 1000000000, knownUsd: total.known / 1000000000,
          unknownUsd: total.unknown / 1000000000, remainingUsd: Math.max(0, cap - total.charged) / 1000000000, reservations: states.size };
      },
      close,
    };
  } catch (error) { close(); throw error; }
}
