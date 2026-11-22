// The pinned Zig that packages/native and the compiler in Zig
// (packages/codegen/zig) build their wasm with: from the PATH if it is that
// version, else the release downloaded once into ~/.cache/swf2es and
// checked against its SHA-256. A download goes to a directory of its own
// and is renamed into place only once extracted, so an interrupted or
// concurrent build never sees half an install, and two builds never write
// the same file. Zig 0.17.0 is pinned for good (docs/zig-codegen.md).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

export const ZIG_VERSION = "0.17.0";

/** The release's tarballs, from ziglang.org/download/index.json. */
const ZIG_SHA256: Record<string, string> = {
  "x86_64-linux": "1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026",
  "aarch64-linux": "9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8",
  "x86_64-macos": "4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6",
  "aarch64-macos": "b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a",
};

/** Written last into an install, before it is renamed into place. */
const COMPLETE = ".swf2es-complete";

/** The pinned Zig's executable, downloading it if need be. */
export function findZig(): string {
  try {
    if (execFileSync("zig", ["version"]).toString().trim() === ZIG_VERSION) {
      return "zig";
    }
  } catch {
    // Not on the PATH.
  }

  const os = process.platform === "darwin" ? "macos" : process.platform;
  const platform = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${os}`;
  const sha256 = ZIG_SHA256[platform];
  if (!sha256 || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new Error(`put Zig ${ZIG_VERSION} on the PATH to rebuild the wasm modules`);
  }

  const name = `zig-${platform}-${ZIG_VERSION}`;
  const cache = swf2esCache();
  const install = join(cache, name);
  if (existsSync(join(install, COMPLETE))) {
    return join(install, "zig");
  }

  mkdirSync(cache, { recursive: true });
  const work = mkdtempSync(join(cache, `${name}-`));
  try {
    const archive = join(work, `${name}.tar.xz`);
    execFileSync("curl", [
      "-fsSL",
      "-o",
      archive,
      `https://ziglang.org/download/${ZIG_VERSION}/${name}.tar.xz`,
    ]);
    const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (actual !== sha256) {
      throw new Error(`${name}.tar.xz has SHA-256 ${actual}, not ${sha256}`);
    }

    execFileSync("tar", ["-xJf", archive, "-C", work]);
    writeFileSync(join(work, name, COMPLETE), "");
    // An install without the marker, from an older build.ts, is replaced.
    if (!existsSync(join(install, COMPLETE))) {
      rmSync(install, { recursive: true, force: true });
      try {
        renameSync(join(work, name), install);
      } catch (error) {
        // Another build renamed its own into place first.
        if (!existsSync(join(install, COMPLETE))) {
          throw error;
        }
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  return join(install, "zig");
}

/** ~/.cache/swf2es, or under $XDG_CACHE_HOME. */
export function swf2esCache(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "swf2es");
}

/**
 * Run the pinned Zig in `cwd`: with its caches in `cache`, else in fresh
 * ones removed after, so that nothing of an earlier build is reused.
 */
export function runZig(cwd: string, args: string[], cache?: string): void {
  mkdirSync(swf2esCache(), { recursive: true });
  const work = cache ?? mkdtempSync(join(swf2esCache(), "zig-build-"));
  try {
    execFileSync(findZig(), args, {
      cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        ZIG_LOCAL_CACHE_DIR: join(work, "local"),
        ZIG_GLOBAL_CACHE_DIR: join(work, "global"),
      },
    });
  } finally {
    if (cache === undefined) {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

/**
 * The SHA-256 of what a build's output follows from: the pinned Zig's
 * version and `files`, each by its path from `root` and its bytes.
 */
export function inputDigest(root: string, files: string[]): string {
  const digest = createHash("sha256").update(`${ZIG_VERSION}\n`);
  for (const file of [...files].sort()) {
    digest.update(`${relative(root, file).split(sep).join("/")}\n`);
    digest.update(readFileSync(file));
  }

  return digest.digest("hex");
}
