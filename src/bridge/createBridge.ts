// src/bridge/createBridge.ts — the bridge factory: loads the store once, exposes exactly five read-only tools, and runs every
// call through one path: argument parse ⇒ tool ⇒ output-schema check ⇒ audit (hashes and sizes only). Failures become
// {code, message, field?}; unexpected exceptions become `internal` with no stack or record bytes. `ops` exists so the parity
// harness can run named mutants (M4); the stdio entry never passes it.
import { join } from "node:path";
import { createAuditLog } from "../mcpkit/audit.ts";
import { CAP_BYTES, jsonBytes } from "../mcpkit/cap.ts";
import { ToolError, toErrorPayload, type ErrorPayload } from "../mcpkit/errors.ts";
import { logErr } from "../mcpkit/logger.ts";
import type { ToolPayload } from "./envelope.ts";
import { mergeOps, type BridgeOps } from "./ops.ts";
import { findPackageRoot } from "./packageRoot.ts";
import { loadStore, type Store } from "./store.ts";
import type { ToolDef, ToolImpl } from "./tool.ts";
import { accountGet } from "./tools/accountGet.ts";
import { accountsFind } from "./tools/accountsFind.ts";
import { agingSummary } from "./tools/agingSummary.ts";
import { describeLayouts } from "./tools/describeLayouts.ts";
import { transactionsList } from "./tools/transactionsList.ts";

export type { BridgeOps } from "./ops.ts";
export { defaultOps } from "./ops.ts";
export type { ToolDef } from "./tool.ts";

export const TOOL_NAMES = [
  "describe_layouts",
  "account_get",
  "accounts_find",
  "transactions_list",
  "aging_summary",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type ToolResult =
  | { ok: true; structured: Record<string, unknown>; text: string }
  | { ok: false; error: ErrorPayload };

export type Bridge = {
  tools: ToolDef[];
  /** sha256 binding of the served data files (also bound into every cursor). */
  fixtureDigest: string;
  call(name: string, args: unknown): Promise<ToolResult>;
};

export type CreateBridgeOptions = {
  /** Directory holding ACCTMSTR.DAT and TRANS.DAT. */
  dataRoot: string;
  /** JSONL audit path; null or absent = no audit. */
  auditPath?: string | null;
  /** Mutant overrides (parity harness only). */
  ops?: Partial<BridgeOps>;
  /** Directory holding layouts/ and copybooks/; defaults to <package root>/fixtures. */
  fixturesDir?: string;
  /** Result size cap in bytes; defaults to CAP_BYTES (65,536). Tests lower it to exercise truncation. */
  capBytes?: number;
};

const TOOLS: readonly ToolImpl[] = [describeLayouts, accountGet, accountsFind, transactionsList, agingSummary];

function publicDef(t: ToolImpl): ToolDef {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
  };
}

export function createBridge(opts: CreateBridgeOptions): Bridge {
  const ops = mergeOps(opts.ops);
  const fixturesDir = opts.fixturesDir ?? join(findPackageRoot(import.meta.url), "fixtures");
  const capBytes = opts.capBytes ?? CAP_BYTES;
  if (!Number.isSafeInteger(capBytes) || capBytes < 1) throw new Error("capBytes must be a positive integer");
  const store: Store = loadStore({ dataRoot: opts.dataRoot, fixturesDir, ops });
  const audit = createAuditLog(opts.auditPath ?? null);
  const byName = new Map<string, ToolImpl>(TOOLS.map((t) => [t.name, t]));

  const run = (name: string, args: unknown): ToolPayload => {
    const tool = byName.get(name);
    if (tool === undefined) throw new ToolError("unknown_tool", "unknown tool; this server exposes five read-only tools");
    const payload = tool.run(args, { store, ops, capBytes });
    const checked = tool.outputSchema.safeParse(payload.structuredContent);
    if (!checked.success) {
      logErr(`${name}: result failed its output schema: ${checked.error.issues[0]?.message ?? "unknown issue"}`);
      throw new ToolError("internal", "result failed its output schema");
    }
    return payload;
  };

  return {
    tools: TOOLS.map(publicDef),
    fixtureDigest: store.fixtureDigest,
    async call(name: string, args: unknown): Promise<ToolResult> {
      const started = performance.now();
      let result: ToolResult;
      let auditBody: unknown;
      try {
        const payload = run(name, args);
        const text = payload.content[0]?.text ?? "";
        result = { ok: true, structured: payload.structuredContent, text };
        auditBody = payload;
      } catch (e) {
        if (!(e instanceof ToolError)) logErr(`${name}: unexpected error: ${e instanceof Error ? e.message : String(e)}`);
        const error = toErrorPayload(e);
        result = { ok: false, error };
        auditBody = { error };
      }
      try {
        audit.record({
          tool: name,
          args,
          result: auditBody,
          bytes: jsonBytes(auditBody),
          ms: Math.round(performance.now() - started),
          error_code: result.ok ? null : result.error.code,
        });
      } catch (e) {
        return { ok: false, error: toErrorPayload(e) };
      }
      return result;
    },
  };
}
