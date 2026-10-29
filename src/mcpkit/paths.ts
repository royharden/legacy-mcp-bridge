// src/mcpkit/paths.ts — data-file access confined to a canonical root. Only fixed basenames are opened; every resolved path
// is realpath'd and must stay inside the root (case-insensitive on win32), so `..`, absolute, encoded and symlink/junction
// escapes are rejected with ToolError path_rejected. No caller-controlled path ever reaches the filesystem unchecked.
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ToolError } from "./errors.ts";

export const DATA_FILES = ["ACCTMSTR.DAT", "TRANS.DAT"] as const;
export type DataFileName = (typeof DATA_FILES)[number];

/** One path segment: plain name characters only (no separators, no "%", no ".", no ".."). */
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function errCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

function norm(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/** True when `child` is `root` itself or lies beneath it (both already canonical). */
export function isInside(root: string, child: string): boolean {
  const rel = relative(norm(root), norm(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

/** Canonical (realpath) form of a data root; it must exist and be a directory. */
export function resolveDataRoot(root: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(root));
  } catch (e) {
    throw new ToolError("path_rejected", `data root cannot be resolved (${errCode(e) ?? "error"})`);
  }
  if (!statSync(canonical).isDirectory()) throw new ToolError("path_rejected", "data root is not a directory");
  return canonical;
}

/**
 * Resolve a relative path under the root. Rejects absolute paths, empty/"."/".." segments and any segment with characters
 * outside [A-Za-z0-9_.-] (which covers URL-encoded forms such as %2e%2e), then realpaths the target and rejects it if it
 * escapes the canonical root (symlink or junction anywhere on the way) or if the final component is itself a link.
 */
export function resolveInsideRoot(root: string, relPath: string): string {
  const canonicalRoot = resolveDataRoot(root);
  if (relPath.length === 0 || isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || relPath.startsWith("\\\\")) {
    throw new ToolError("path_rejected", "path must be relative to the data root");
  }
  const segments = relPath.split(/[\\/]/);
  for (const s of segments) {
    if (!SEGMENT_RE.test(s) || s === "." || s === "..") throw new ToolError("path_rejected", "path segment rejected");
  }
  const candidate = join(canonicalRoot, ...segments);
  if (!isInside(canonicalRoot, candidate)) throw new ToolError("path_rejected", "path escapes the data root");

  let real: string;
  try {
    real = realpathSync.native(candidate);
  } catch (e) {
    const code = errCode(e);
    if (code === "ENOENT") throw new ToolError("internal", "data file missing");
    throw new ToolError("path_rejected", `path cannot be resolved (${code ?? "error"})`);
  }
  if (!isInside(canonicalRoot, real)) throw new ToolError("path_rejected", "path escapes the data root via a link");
  if (lstatSync(candidate).isSymbolicLink()) throw new ToolError("path_rejected", "data file is a symbolic link");
  if (norm(relative(canonicalRoot, real)) !== norm(segments.join(sep))) {
    throw new ToolError("path_rejected", "path resolves to a different file under the data root");
  }
  return real;
}

/** Read one of the two fixed data files under the root as raw bytes. */
export function openFixedFile(root: string, basename: DataFileName): Buffer {
  if (!DATA_FILES.some((f) => f === basename)) throw new ToolError("path_rejected", "not an allowed data file");
  const real = resolveInsideRoot(root, basename);
  if (!statSync(real).isFile()) throw new ToolError("path_rejected", "data path is not a regular file");
  return readFileSync(real);
}
