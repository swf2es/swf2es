// What the compiler's wasm is built from, and where its modules go: for
// build.ts, which builds them and keeps their digests in digests.json, and
// for the tools that must know whether the built modules are this tree's
// (tests/parity/reference.ts).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inputDigest } from "../../../tools/zig.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
export const pkg = join(here, "..");
export const digestsFile = join(here, "digests.json");

/** Each module build.zig installs, and where in the package it goes. */
export const MODULES: Record<string, string> = {
  codegen: "dist/codegen.wasm",
  testing: "dist-test/testing.wasm",
  "testing-poison": "dist-test/testing-poison.wasm",
};

export interface Digests {
  zig: string;
  inputs: string;
  modules: Record<string, string>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function zigFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".zig"))
    .map((file) => join(dir, file));
}

/** The digest of the modules' inputs: the Zig sources, build.zig, this, build.ts, stamp.ts and the Zig version. */
export function inputs(): string {
  return inputDigest(pkg, [
    ...zigFiles(join(here, "src")),
    join(here, "build.zig"),
    join(here, "build.ts"),
    fileURLToPath(import.meta.url),
    join(pkg, "stamp.ts"),
  ]);
}

export function recorded(): Digests | null {
  return existsSync(digestsFile) ? JSON.parse(readFileSync(digestsFile, "utf8")) : null;
}

/** The SHA-256 of each module in the package, "" for one not built. */
export function built(): Record<string, string> {
  const modules: Record<string, string> = {};
  for (const path of Object.values(MODULES)) {
    const file = join(pkg, path);
    modules[path] = existsSync(file) ? sha256(readFileSync(file)) : "";
  }

  return modules;
}
