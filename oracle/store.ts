// The oracle's compile store, shared by every checkout on the machine: what
// ASC, gcc and abcdump made of their inputs, by a key that hashes those
// inputs (see oracle.ts), so a new worktree compiles nothing the machine has
// compiled before. $SWF2ES_ORACLE_CACHE names it; by default it is
// swf2es/oracle under $XDG_CACHE_HOME or ~/.cache.
//
// Each entry is a file <key>.<kind>, written whole under a temporary name and
// renamed into place, so checkouts that run at once never see half of one.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function storeDir(): string {
  return (
    process.env.SWF2ES_ORACLE_CACHE ||
    join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "swf2es", "oracle")
  );
}

function entry(key: string, kind: string): string {
  return join(storeDir(), key.slice(0, 2), `${key}.${kind}`);
}

export function stored(key: string, kind: string): boolean {
  return existsSync(entry(key, kind));
}

/**
 * Put the stored entry at `dest`, hard-linked or else copied. Whatever was at
 * `dest` is unlinked first: writing through it would change the entry.
 */
export function take(key: string, kind: string, dest: string): boolean {
  const from = entry(key, kind);
  if (!existsSync(from)) {
    return false;
  }

  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  try {
    linkSync(from, dest);
  } catch {
    copyFileSync(from, dest);
    chmodSync(dest, statSync(from).mode);
  }

  return true;
}

/** Store a copy of `src`, which its writer may later overwrite in place. */
export function put(key: string, kind: string, src: string): void {
  const to = entry(key, kind);
  mkdirSync(dirname(to), { recursive: true });
  const temp = `${to}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    copyFileSync(src, temp);
    chmodSync(temp, statSync(src).mode);
    renameSync(temp, to);
  } finally {
    rmSync(temp, { force: true });
  }
}
