// The builds the parity harness (run.ts) and the compile-time benchmark
// (tests/bench/codegen-compile.ts) compare: a reference, from a git ref,
// and the candidate, this tree's.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { built, inputs, recorded } from "../../packages/codegen/zig/inputs.ts";
import { runZig, swf2esCache, ZIG_VERSION } from "../../tools/zig.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The reference's modules, the names its build.zig gave them (as at zig-last-parity, or as since), and its digests.json's. */
const REFERENCE_MODULES = [
  {
    name: "codegen",
    built: ["codegen", "codegen-zig"],
    digested: ["dist/codegen.wasm", "dist/codegen-zig.wasm"],
  },
  {
    name: "testing",
    built: ["testing", "testing-zig"],
    digested: ["dist-test/testing.wasm", "dist-test/testing-zig.wasm"],
  },
];

/**
 * The reference's release and test builds, built once from `ref`'s
 * packages/codegen/zig by this tree's pinned Zig (its version is in the
 * cache's key, beside the commit), the release build stamped as pnpm build
 * stamps it, each checked against the ref's own digests.json where it has
 * one, and kept in ~/.cache/swf2es/parity/<zig>-<commit>/, written whole
 * or not at all.
 */
export function referenceBuild(ref: string): { dir: string; commit: string } {
  const commit = execFileSync("git", ["rev-parse", `${ref}^{commit}`], { cwd: root })
    .toString()
    .trim();
  const dir = join(swf2esCache(), "parity", `${ZIG_VERSION}-${commit}`);
  if (REFERENCE_MODULES.every((m) => existsSync(join(dir, `${m.name}.wasm`)))) {
    return { dir, commit };
  }

  const work = mkdtempSync(join(swf2esCache(), "parity-source-"));
  try {
    const archive = execFileSync("git", ["archive", commit, "packages/codegen/zig"], {
      cwd: root,
      maxBuffer: 1 << 30,
    });
    execFileSync("tar", ["-x", "-C", work], { input: archive });
    const prefix = join(work, "out");
    console.log(`parity: building the reference, ${ref} (${commit.slice(0, 9)})`);
    runZig(
      join(work, "packages/codegen/zig"),
      ["build", "--prefix", prefix],
      join(swf2esCache(), "zig-codegen-cache"),
    );
    let digests: { modules?: Record<string, string> } = {};
    try {
      digests = JSON.parse(
        execFileSync("git", ["show", `${commit}:packages/codegen/zig/digests.json`], {
          cwd: root,
          stdio: ["ignore", "pipe", "ignore"],
        }).toString(),
      );
    } catch {
      // A ref from before the digests.
    }

    const staged = join(work, "staged");
    mkdirSync(staged);
    for (const module of REFERENCE_MODULES) {
      const from = module.built
        .map((name) => join(prefix, "bin", `${name}.wasm`))
        .find((path) => existsSync(path));
      if (!from) {
        throw new Error(`the reference's build has no ${module.name}.wasm`);
      }

      const to = join(staged, `${module.name}.wasm`);
      copyFileSync(from, to);
      if (module.name === "codegen") {
        execFileSync(process.execPath, [join(root, "packages/codegen/stamp.ts"), to]);
      }

      const want = module.digested.map((path) => digests.modules?.[path]).find(Boolean);
      if (want && want !== sha256(to)) {
        throw new Error(
          `the reference's ${module.name}.wasm, ${sha256(to)}, is not its digests.json's, ${want}`,
        );
      }
    }

    mkdirSync(join(swf2esCache(), "parity"), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    renameSync(staged, dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  return { dir, commit };
}

/**
 * This tree's builds, made from its sources: build.ts runs first, which
 * builds them again where they are not digests.json's or the sources moved
 * since. The release build's path.
 */
export function candidateBuild(): { release: string } {
  execFileSync(process.execPath, [join(root, "packages/codegen/zig/build.ts")], {
    stdio: "inherit",
  });
  const digests = recorded();
  if (digests?.inputs !== inputs()) {
    console.log("parity: the candidate is built from sources digests.json does not record yet");
  } else if (JSON.stringify(built()) !== JSON.stringify(digests.modules)) {
    console.log("parity: the candidate's modules are not digests.json's for these sources");
  }

  return { release: join(root, "packages/codegen/dist/codegen.wasm") };
}
