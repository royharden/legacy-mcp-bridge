// Shared condition boundary; tools receive only model-supplied arguments, never the truth or selected dataset view.
import type { ToolDefinition } from "../../lib/providers/types.ts";
export type ConditionId = "A" | "C2" | "C" | "D";
export type EvalToolResult = { ok: true; structured: Record<string, unknown>; text: string; rawBytes?: number } | { ok: false; error: { code: string; message: string } };
export type Condition = { id: ConditionId; system: string; tools: ToolDefinition[]; fixtureDigest: string | null; call(name: string, args: unknown): Promise<EvalToolResult> };
