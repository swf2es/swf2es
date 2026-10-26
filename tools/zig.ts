// The pinned Zig that packages/native builds its wasm
// with: from the PATH if it is that version, else the release downloaded
// once into ~/.cache/swf2es and checked against its SHA-256. A download
// goes to a directory of its own and is renamed into place only once
// extracted, so an interrupted or concurrent build never sees half an
// install, and two builds never write the same file.
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
import { join } from "node:path";

export const ZIG_VERSION = "0.17.0";

/** The release's tarballs, from ziglang.org/download/index.json. */
const ZIG_SHA256: Record<string, string> = {
  "x86_64-linux": "1cbe9df9f27e6b78d14ccbca43b6703a404ef79ef1c463de901d7f088d4e2026",
  "aarch64-linux": "9e8d11661d4ae3bd57702a3832781e23ad151dde5798e16a5ccd503f65234ff8",
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

  const platform = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform}`;
  const sha256 = ZIG_SHA256[platform];
  if (!sha256 || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new Error(`put Zig ${ZIG_VERSION} on the PATH to rebuild the wasm modules`);
  }

  const name = `zig-${platform}-${ZIG_VERSION}`;
  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "swf2es");
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
