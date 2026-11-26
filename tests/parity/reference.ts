// A reference build of the compiler from a git ref, for the parity harness
// (run.ts) and the compile-time benchmark (tests/bench/codegen-compile.ts):
// its release and test builds, built once by the pinned Zig from the ref's
// packages/codegen/zig and kept in ~/.cache/swf2es/parity/<commit>/.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runZig, swf2esCache } from "../../tools/zig.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The reference's release and test builds, built once by the pinned Zig
 * from `ref`'s packages/codegen/zig and kept by its commit. Its artifacts
 * are named as at zig-last-parity (codegen-zig, testing-zig, ...) or as
 * since (codegen, testing, ...).
 */
export function referenceBuild(ref: string): { dir: string; commit: string } {
  const commit = execFileSync("git", ["rev-parse", `${ref}^{commit}`], { cwd: root })
    .toString()
    .trim();
  const dir = join(swf2esCache(), "parity", commit);
  const files = ["codegen.wasm", "testing.wasm", "testing-poison.wasm"];
  if (files.every((f) => existsSync(join(dir, f)))) {
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
    mkdirSync(dir, { recursive: true });
    for (const name of ["codegen", "testing", "testing-poison"]) {
      const zig = name.replace(/^(codegen|testing)/, "$1-zig");
      const from = [join(prefix, "bin", `${name}.wasm`), join(prefix, "bin", `${zig}.wasm`)].find(
        (path) => existsSync(path),
      );
      if (!from) {
        throw new Error(`the reference's build has no ${name}.wasm`);
      }

      copyFileSync(from, join(dir, `${name}.wasm`));
    }

    // Stamped as pnpm build stamps the release build, so that sizes compare.
    execFileSync(process.execPath, [
      join(root, "packages/codegen/stamp.ts"),
      join(dir, "codegen.wasm"),
    ]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  return { dir, commit };
}
