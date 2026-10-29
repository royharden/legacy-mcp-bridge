// Locates the package root (the directory whose package.json names this package) from a module URL.
// src/server/stdio.ts and dist/server/stdio.js sit at different depths, so walk up instead of using a fixed "../..".
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "legacy-mcp-bridge";

function namesThisPackage(file: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && (parsed as { name?: unknown }).name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

export function findPackageRoot(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate) && namesThisPackage(candidate)) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`package root of ${PACKAGE_NAME} not found above ${fileURLToPath(moduleUrl)}`);
    dir = parent;
  }
}
