// tests/contract/mcpkit.paths.test.ts — data-file containment: traversal (`..`, absolute, URL-encoded), directory junction
// escape (Windows junctions need no admin), file-symlink escape (skipped WITH a logged reason when the OS refuses with
// EPERM), case-insensitive containment on win32. All files are temp copies of literal bytes.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ToolError } from "../../src/mcpkit/errors.ts";
import { isInside, openFixedFile, resolveDataRoot, resolveInsideRoot } from "../../src/mcpkit/paths.ts";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof ToolError ? e.code : `non-ToolError:${String(e)}`;
  }
  return "no error";
}

const INSIDE_BYTES = Buffer.from("0000000042INSIDE", "latin1");
const OUTSIDE_BYTES = Buffer.from("SECRET-OUTSIDE-ROOT", "latin1");

// Probe once at collection time whether this OS lets us create a file symlink (Windows without Developer Mode or admin
// refuses with EPERM). The reason is logged and carried in the test name, so a skip is never silent.
const symlinkProbe = ((): { ok: boolean; reason: string } => {
  const dir = mkdtempSync(join(tmpdir(), "lmb-probe-"));
  try {
    writeFileSync(join(dir, "target"), "x");
    symlinkSync(join(dir, "target"), join(dir, "link"), "file");
    return { ok: true, reason: "" };
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "unknown";
    return { ok: false, reason: `file symlink creation refused by the OS (${code}); needs Developer Mode or admin on Windows` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
if (!symlinkProbe.ok) process.stderr.write(`[mcpkit.paths.test] SKIP file-symlink escape: ${symlinkProbe.reason}\n`);

let base = "";
let root = "";
let outside = "";

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "lmb-paths-")));
  root = join(base, "data");
  outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, "ACCTMSTR.DAT"), INSIDE_BYTES);
  writeFileSync(join(root, "TRANS.DAT"), INSIDE_BYTES);
  writeFileSync(join(outside, "ACCTMSTR.DAT"), OUTSIDE_BYTES);
  writeFileSync(join(outside, "TRANS.DAT"), OUTSIDE_BYTES);
});

afterAll(() => {
  if (base !== "") rmSync(base, { recursive: true, force: true });
});

describe("openFixedFile happy path", () => {
  it("reads the fixed basenames as raw bytes", () => {
    expect(openFixedFile(root, "ACCTMSTR.DAT").equals(INSIDE_BYTES)).toBe(true);
    expect(openFixedFile(root, "TRANS.DAT").equals(INSIDE_BYTES)).toBe(true);
  });
  it("refuses any basename outside the allowlist even if the type is bypassed", () => {
    expect(codeOf(() => openFixedFile(root, "../outside/ACCTMSTR.DAT" as never))).toBe("path_rejected");
    expect(codeOf(() => openFixedFile(root, "acctmstr.json" as never))).toBe("path_rejected");
  });
  it("a missing data file is internal, not a lookup miss", () => {
    const empty = join(base, "empty");
    mkdirSync(empty, { recursive: true });
    expect(codeOf(() => openFixedFile(empty, "ACCTMSTR.DAT"))).toBe("internal");
  });
  it("a missing data root is path_rejected", () => {
    expect(codeOf(() => resolveDataRoot(join(base, "nope")))).toBe("path_rejected");
  });
});

describe("traversal", () => {
  it.each(["../outside/ACCTMSTR.DAT", "..\\outside\\ACCTMSTR.DAT", "./ACCTMSTR.DAT", "sub/../ACCTMSTR.DAT", "..", ""])(
    "rejects dot segments: %j",
    (rel) => {
      expect(codeOf(() => resolveInsideRoot(root, rel))).toBe("path_rejected");
    },
  );

  it("rejects absolute paths (native, POSIX, drive-letter, UNC)", () => {
    expect(codeOf(() => resolveInsideRoot(root, join(outside, "ACCTMSTR.DAT")))).toBe("path_rejected");
    expect(codeOf(() => resolveInsideRoot(root, "/etc/passwd"))).toBe("path_rejected");
    expect(codeOf(() => resolveInsideRoot(root, "C:\\Windows\\win.ini"))).toBe("path_rejected");
    expect(codeOf(() => resolveInsideRoot(root, "C:ACCTMSTR.DAT"))).toBe("path_rejected");
    expect(codeOf(() => resolveInsideRoot(root, "\\\\server\\share\\ACCTMSTR.DAT"))).toBe("path_rejected");
  });

  it.each(["%2e%2e%2fACCTMSTR.DAT", "%2e%2e/outside/ACCTMSTR.DAT", "..%2fACCTMSTR.DAT", "%252e%252e%252fACCTMSTR.DAT", "ACCTMSTR.DAT%00"])(
    "rejects URL-encoded forms: %j",
    (rel) => {
      expect(codeOf(() => resolveInsideRoot(root, rel))).toBe("path_rejected");
    },
  );

  it("rejects stream and wildcard characters", () => {
    expect(codeOf(() => resolveInsideRoot(root, "ACCTMSTR.DAT:secret"))).toBe("path_rejected");
    expect(codeOf(() => resolveInsideRoot(root, "*.DAT"))).toBe("path_rejected");
  });
});

describe("link escapes", () => {
  it("rejects a directory junction (symlink on POSIX) that escapes the root", () => {
    // "junction" needs no admin on Windows; on POSIX the type argument is ignored and a directory symlink is made.
    symlinkSync(outside, join(root, "escape"), "junction");
    expect(codeOf(() => resolveInsideRoot(root, "escape/ACCTMSTR.DAT"))).toBe("path_rejected");
  });

  it("rejects a junction that points back inside the root (resolves to a different file)", () => {
    symlinkSync(root, join(root, "loop"), "junction");
    expect(codeOf(() => resolveInsideRoot(root, "loop/ACCTMSTR.DAT"))).toBe("path_rejected");
  });

  it("accepts a data root that is itself reached through a junction (canonicalised first)", () => {
    const viaJunction = join(base, "root-junction");
    symlinkSync(root, viaJunction, "junction");
    expect(resolveDataRoot(viaJunction)).toBe(resolveDataRoot(root));
    expect(openFixedFile(viaJunction, "ACCTMSTR.DAT").equals(INSIDE_BYTES)).toBe(true);
  });

  it.skipIf(!symlinkProbe.ok)(
    `rejects a file symlink escaping the root${symlinkProbe.ok ? "" : ` [SKIPPED: ${symlinkProbe.reason}]`}`,
    () => {
      const linkRoot = join(base, "linkroot");
      mkdirSync(linkRoot, { recursive: true });
      symlinkSync(join(outside, "ACCTMSTR.DAT"), join(linkRoot, "ACCTMSTR.DAT"), "file");
      expect(codeOf(() => openFixedFile(linkRoot, "ACCTMSTR.DAT"))).toBe("path_rejected");
    },
  );

  it.skipIf(!symlinkProbe.ok)(
    `rejects a file symlink even when it points inside the root${symlinkProbe.ok ? "" : ` [SKIPPED: ${symlinkProbe.reason}]`}`,
    () => {
      const linkRoot = join(base, "linkroot-inside");
      mkdirSync(linkRoot, { recursive: true });
      writeFileSync(join(linkRoot, "real.bin"), INSIDE_BYTES);
      symlinkSync(join(linkRoot, "real.bin"), join(linkRoot, "TRANS.DAT"), "file");
      expect(codeOf(() => openFixedFile(linkRoot, "TRANS.DAT"))).toBe("path_rejected");
    },
  );
});

describe("containment comparison", () => {
  it("rejects siblings that share a prefix", () => {
    expect(isInside(join(base, "data"), join(base, "data-evil", "ACCTMSTR.DAT"))).toBe(false);
    expect(isInside(join(base, "data"), join(base, "data", "ACCTMSTR.DAT"))).toBe(true);
  });

  it.runIf(process.platform === "win32")("is case-insensitive on win32", () => {
    expect(isInside("C:\\Data\\Legacy", "c:\\data\\legacy\\ACCTMSTR.DAT")).toBe(true);
    expect(openFixedFile(root.toUpperCase(), "ACCTMSTR.DAT").equals(INSIDE_BYTES)).toBe(true);
  });
});
