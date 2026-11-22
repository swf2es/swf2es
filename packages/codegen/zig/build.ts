// Builds the compiler in Zig (build.zig, docs/zig-codegen.md) with the
// pinned Zig (tools/zig.ts): dist/codegen-zig.wasm, stamped with its
// identity as codegen.wasm is (stamp.ts), and the test builds in
// dist-test/. The modules are not checked in. digests.json is: the digest
// of their inputs, and of each module built from them, which the pinned
// Zig builds byte for byte alike on any machine.
//
//   node zig/build.ts           pnpm build: nothing to do where the modules
//                               in dist/ are digests.json's and so are the
//                               inputs; else a build, with Zig's caches
//                               kept, each module held to its digest if
//                               the inputs are digests.json's
//   node zig/build.ts --update  the inline tests (zig build test), then a
//                               build with fresh caches, its digests written
//   node zig/build.ts --verify  the same, failing where the inputs or a
//                               module are not digests.json's: CI's check
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inputDigest, runZig, swf2esCache, ZIG_VERSION } from "../../../tools/zig.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const pkg = join(here, "..");
const digestsFile = join(here, "digests.json");

/** Each module build.zig installs, and where in the package it goes. */
const MODULES: Record<string, string> = {
  "codegen-zig": "dist/codegen-zig.wasm",
  "testing-zig": "dist-test/testing-zig.wasm",
  "testing-zig-poison": "dist-test/testing-zig-poison.wasm",
};
const STAMPED = new Set(["codegen-zig"]);

interface Digests {
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

function inputs(): string {
  return inputDigest(pkg, [
    ...zigFiles(join(here, "src")),
    join(here, "build.zig"),
    fileURLToPath(import.meta.url),
    join(pkg, "stamp.ts"),
  ]);
}

function recorded(): Digests | null {
  return existsSync(digestsFile) ? JSON.parse(readFileSync(digestsFile, "utf8")) : null;
}

function built(): Record<string, string> {
  const modules: Record<string, string> = {};
  for (const path of Object.values(MODULES)) {
    const file = join(pkg, path);
    modules[path] = existsSync(file) ? sha256(readFileSync(file)) : "";
  }

  return modules;
}

/** The modules built into the package, with Zig's caches in `cache`, else fresh ones. */
async function build(cache?: string): Promise<void> {
  const prefix = mkdtempSync(join(swf2esCache(), "zig-codegen-out-"));
  try {
    runZig(here, ["build", "--prefix", prefix], cache);
    for (const [name, path] of Object.entries(MODULES)) {
      const bytes = readFileSync(join(prefix, "bin", `${name}.wasm`));
      const imports = WebAssembly.Module.imports(await WebAssembly.compile(bytes));
      if (JSON.stringify(imports.map((i) => `${i.module}.${i.name}`)) !== '["env.abort"]') {
        throw new Error(`${name}.wasm imports ${JSON.stringify(imports)}, not only env.abort`);
      }

      const file = join(pkg, path);
      mkdirSync(dirname(file), { recursive: true });
      copyFileSync(join(prefix, "bin", `${name}.wasm`), file);
      if (STAMPED.has(name)) {
        execFileSync(process.execPath, [join(pkg, "stamp.ts"), file]);
      }
    }
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}

function report(started: number): void {
  const sizes = Object.values(MODULES).map((path) => {
    const bytes = readFileSync(join(pkg, path));
    return `${path} ${bytes.length} bytes`;
  });
  console.log(`zig: ${sizes.join(", ")} (${((performance.now() - started) / 1000).toFixed(1)} s)`);
}

const started = performance.now();
const digests = recorded();
const now = inputs();
if (process.argv.includes("--update") || process.argv.includes("--verify")) {
  runZig(here, ["build", "test"]);
  await build();
  report(started);
  const fresh: Digests = { zig: ZIG_VERSION, inputs: now, modules: built() };
  if (process.argv.includes("--update")) {
    writeFileSync(digestsFile, `${JSON.stringify(fresh, null, 2)}\n`);
  } else if (JSON.stringify(fresh) !== JSON.stringify(digests)) {
    throw new Error(
      `the Zig modules or their inputs are not those of packages/codegen/zig/digests.json; ` +
        `run node packages/codegen/zig/build.ts --update\n${JSON.stringify(fresh, null, 2)}`,
    );
  }
} else if (digests?.inputs !== now || JSON.stringify(built()) !== JSON.stringify(digests.modules)) {
  await build(join(swf2esCache(), "zig-codegen-cache"));
  report(started);
  if (digests?.inputs === now) {
    for (const [path, digest] of Object.entries(built())) {
      if (digest !== digests.modules[path]) {
        throw new Error(
          `${path} has SHA-256 ${digest}, but digests.json has ${digests.modules[path]} for its inputs: ` +
            `Zig ${ZIG_VERSION} built it otherwise here`,
        );
      }
    }
  } else {
    console.warn(
      "zig: packages/codegen/zig/digests.json is not of these sources; run node packages/codegen/zig/build.ts --update",
    );
  }
}
