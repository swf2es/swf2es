// Builds the compiler in Zig (build.zig, docs/zig-codegen.md) with the
// pinned Zig (tools/zig.ts): dist/codegen.wasm, stamped with its
// identity as codegen.wasm is (stamp.ts), and the test builds in
// dist-test/. The modules are not checked in. digests.json is: the digest
// of their inputs, and of each module built from them, which the pinned
// Zig builds byte for byte alike on any machine.
//
//   node zig/build.ts           pnpm build: nothing to do where the modules
//                               in dist/ are digests.json's and so are the
//                               inputs; else a build, with Zig's caches
//                               kept, and a warning for a module that is
//                               not digests.json's for the same inputs, as
//                               another host's Zig might build it (CI's
//                               --verify fails on it)
//   node zig/build.ts --update  the inline tests (zig build test), then a
//                               build with fresh caches, its digests written
//   node zig/build.ts --verify  the same, failing where the inputs or a
//                               module are not digests.json's: CI's check
//   node zig/build.ts --names   dist-test/codegen-names.wasm, the compiler
//                               with the name section, so that a trap's
//                               stack names its functions (zig build names)
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runZig, swf2esCache, ZIG_VERSION } from "../../../tools/zig.ts";
import { built, type Digests, digestsFile, inputs, MODULES, pkg, recorded } from "./inputs.ts";

const here = fileURLToPath(new URL(".", import.meta.url));

const STAMPED = new Set(["codegen"]);
/**
 * What the AssemblyScript compiler's build left in the package, which a
 * checkout from before the swap may still have and a pack would ship.
 */
const LEFTOVERS = [
  "dist/codegen.js",
  "dist/codegen.d.ts",
  "dist/codegen.wasm.map",
  "dist/codegen-zig.wasm",
  "dist-test/codegen-as.wasm",
  "dist-test/testing.js",
  "dist-test/testing.d.ts",
  "dist-test/testing-zig.wasm",
  "dist-test/testing-zig-poison.wasm",
  "dist-test-checked",
];

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

for (const path of LEFTOVERS) {
  rmSync(join(pkg, path), { recursive: true, force: true });
}

if (process.argv.includes("--names")) {
  const prefix = mkdtempSync(join(swf2esCache(), "zig-codegen-out-"));
  try {
    runZig(here, ["build", "names", "--prefix", prefix], join(swf2esCache(), "zig-codegen-cache"));
    mkdirSync(join(pkg, "dist-test"), { recursive: true });
    copyFileSync(
      join(prefix, "bin", "codegen-names.wasm"),
      join(pkg, "dist-test", "codegen-names.wasm"),
    );
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }

  console.log("zig: dist-test/codegen-names.wasm");
  process.exit(0);
}

const started = performance.now();
const digests = recorded();
const now = inputs();
if (process.argv.includes("--update") || process.argv.includes("--verify")) {
  // Fresh caches, but one for both, so that Zig's build runner is compiled once.
  const fresh = mkdtempSync(join(swf2esCache(), "zig-codegen-fresh-"));
  try {
    runZig(here, ["build", "test"], fresh);
    await build(fresh);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }

  report(started);
  const made: Digests = { zig: ZIG_VERSION, inputs: now, modules: built() };
  if (process.argv.includes("--update")) {
    writeFileSync(digestsFile, `${JSON.stringify(made, null, 2)}\n`);
  } else if (JSON.stringify(made) !== JSON.stringify(digests)) {
    throw new Error(
      `the Zig modules or their inputs are not those of packages/codegen/zig/digests.json; ` +
        `run node packages/codegen/zig/build.ts --update\n${JSON.stringify(made, null, 2)}`,
    );
  }
} else if (digests?.inputs !== now || JSON.stringify(built()) !== JSON.stringify(digests.modules)) {
  await build(join(swf2esCache(), "zig-codegen-cache"));
  report(started);
  if (digests?.inputs === now) {
    for (const [path, digest] of Object.entries(built())) {
      if (digest !== digests.modules[path]) {
        console.warn(
          `zig: ${path} has SHA-256 ${digest}, but digests.json has ${digests.modules[path]} for its inputs: ` +
            `Zig ${ZIG_VERSION} built it otherwise on this host`,
        );
      }
    }
  } else {
    console.warn(
      "zig: packages/codegen/zig/digests.json is not of these sources; run node packages/codegen/zig/build.ts --update",
    );
  }
}
