// tests/helpers/importScan.ts — regex-level source scanning shared by the static tests: comment stripping, import/export
// specifiers (static, multi-line, side-effect and dynamic forms) and string-literal contents.

export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

const SPECIFIER_RES = [
  /\bfrom\s*["']([^"']+)["']/g, // import … from "x" / export … from "x" (also multi-line import lists)
  /\bimport\s*["']([^"']+)["']/g, // side-effect import "x"
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import("x")
];

export function specifiers(src: string): string[] {
  const text = stripComments(src);
  const out: string[] = [];
  for (const re of SPECIFIER_RES) for (const m of text.matchAll(re)) if (m[1] !== undefined) out.push(m[1]);
  return out;
}

/** Contents of single-line string and template literals (comments removed first). */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(src).matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) if (m[2] !== undefined) out.push(m[2]);
  return out;
}
