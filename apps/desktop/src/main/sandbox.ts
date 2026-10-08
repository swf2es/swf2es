// The sandbox of the SWF playing, as Flash Player chose one for a local
// SWF by FileAttributes' UseNetwork bit: local-with-filesystem reads the
// files in the SWF's own directory and below, and reaches no network;
// local-with-networking reaches the network, and no local file but
// itself. Only the SWF playing now has a grant: opening another, or
// closing it, revokes it. What the SWF loads plays in its sandbox too.
// Apart from Electron, so that node tests it (tests/desktop/sandbox.test.ts).
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, sep } from "node:path";

export const FILE_ORIGIN = "swf2es://file";

export type SandboxType = "localWithFile" | "localWithNetwork";

interface Grant {
  /** The SWF's real path, links followed. */
  swf: string;
  /** The directory it may read under, or null for none: its own file alone. */
  root: string | null;
  /** The URL's first segment, standing for the SWF's directory. */
  token: string;
  type: SandboxType;
}

/** The OS's realpath, links followed, as both the grant and a request use it; null for no such file. */
async function real(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** Whether `path` lies under `root`, not `root` itself. */
function inside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

export class Sandbox {
  private grant: Grant | null = null;
  /**
   * The grant of a SWF opened but not yet asked for. It takes effect as the
   * page fetches the SWF, which it does once it has let the last SWF go,
   * so that one never runs, for a frame, in the next one's sandbox.
   */
  private pending: Grant | null = null;
  /** Directories never granted whole. */
  private readonly shared: Set<string>;

  /**
   * `home` is the user's directory, never granted whole, nor the one that
   * holds every user's (/home, /Users, C:\\Users), nor a temporary one
   * every program shares: a SWF in any of them reads only itself.
   */
  constructor(home = homedir()) {
    const resolve = (path: string) => {
      try {
        return realpathSync.native(path);
      } catch {
        // No such directory: compared as given.
        return path;
      }
    };
    // Each as given and as it really is: a SWF's directory is compared real,
    // and /tmp is /private/tmp on macOS, a home may be a link.
    const shared = [home, dirname(home), tmpdir(), "/tmp", "/var/tmp"];
    this.shared = new Set([...shared, ...shared.map(resolve), dirname(resolve(home))]);
  }

  /** The sandbox of the SWF playing; null when none plays. */
  get type(): SandboxType | null {
    return this.grant?.type ?? null;
  }

  /** The real path of the SWF playing, or opened to play next; null when none. */
  get swf(): string | null {
    return (this.pending ?? this.grant)?.swf ?? null;
  }

  /**
   * Grant `swf` its sandbox, in place of the last SWF's, and give the URL
   * the page plays it from. The URL names the SWF's directory by a token,
   * not its path, so neither loaderInfo.url nor anything the SWF sends
   * tells where on the disk it is, or whose disk; the token, a hash of the
   * path, stays the same from run to run for the SWF's SharedObjects.
   * The shared directories (the constructor's) and a file system's root
   * are never granted whole: a SWF there reads only itself.
   */
  play(swf: string, network: boolean): string {
    const path = realpathSync.native(swf);
    const directory = dirname(path);
    const whole = this.shared.has(directory) || directory === parse(directory).root;
    const token = createHash("sha256").update(directory).digest("hex").slice(0, 16);
    this.grant = null;
    this.pending = {
      swf: path,
      root: network || whole ? null : directory,
      token,
      type: network ? "localWithNetwork" : "localWithFile",
    };
    return `${FILE_ORIGIN}/${token}/${encodeURIComponent(basename(path))}`;
  }

  /** Nothing plays: every grant revoked. */
  stop(): void {
    this.grant = null;
    this.pending = null;
  }

  /** Whether the SWF playing may reach the network: only in local-with-networking. */
  networkAllowed(): boolean {
    return this.grant?.type === "localWithNetwork";
  }

  /** The local file a swf2es://file URL names, if the SWF playing may read it; its path, decoded, is `pathname`. */
  async resolve(pathname: string): Promise<string | null> {
    const [empty, token, ...rest] = pathname.split("/");
    const pending = this.pending;
    if (pending && empty === "" && token === pending.token && rest.length > 0) {
      const path = await real(join(dirname(pending.swf), ...rest));
      if (path === pending.swf && this.pending === pending) {
        this.grant = pending;
        this.pending = null;
      }
    }

    const grant = this.grant;
    if (!grant || empty !== "" || token !== grant.token || rest.length === 0) {
      return null;
    }

    const path = await real(join(dirname(grant.swf), ...rest));
    if (path === null || this.grant !== grant) {
      return null;
    }

    if (path === grant.swf) {
      return path;
    }

    return grant.root !== null && inside(grant.root, path) ? path : null;
  }
}
