// src/bridge/tool.ts — the shape of one bridge tool. A tool parses its own arguments with its strict input schema (zod
// failure ⇒ ToolError bad_argument naming the field) and returns the complete, masked, capped payload.
import type { z } from "zod";
import { parseArgs } from "../mcpkit/validate.ts";
import type { ToolPayload } from "./envelope.ts";
import type { BridgeOps } from "./ops.ts";
import type { Store } from "./store.ts";

export type ToolContext = { store: Store; ops: BridgeOps; capBytes: number };

/** Public description of a tool (what createServer registers). */
export type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: z.AnyZodObject;
  outputSchema: z.AnyZodObject;
};

export type ToolImpl = ToolDef & { run(args: unknown, ctx: ToolContext): ToolPayload };

export function defineTool<I extends z.AnyZodObject>(def: {
  name: string;
  title: string;
  description: string;
  inputSchema: I;
  outputSchema: z.AnyZodObject;
  run: (args: z.output<I>, ctx: ToolContext) => ToolPayload;
}): ToolImpl {
  return {
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: def.inputSchema,
    outputSchema: def.outputSchema,
    run: (args, ctx) => def.run(parseArgs(def.inputSchema, args), ctx),
  };
}
