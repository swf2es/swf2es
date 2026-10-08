// What the app remembers between runs, in settings.json under its user
// data: where the user's libraries are, and the SWFs opened last.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LibraryName, LibraryState } from "../shared/api.js";

export interface Settings {
  playerglobal?: string;
  builtin?: string;
  /** Most recent first. */
  recent: string[];
  /** The servers, "host:port", each SWF, by its real path, is always allowed to connect a socket to. */
  sockets: Record<string, string[]>;
}

const RECENT = 10;

/**
 * builtin.abc is avmplus' (MPL-2.0), and in a checkout of the repository
 * the avmplus submodule has it built; the app uses that when the user has
 * named none and there is none beside their playerglobal.abc.
 */
const checkoutBuiltin = fileURLToPath(
  new URL("../../../../oracle/avmplus/generated/builtin.abc", import.meta.url),
);

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export class SettingsFile {
  private readonly path: string;
  private current: Settings;

  constructor(directory: string) {
    this.path = join(directory, "settings.json");
    this.current = this.read();
  }

  get settings(): Readonly<Settings> {
    return this.current;
  }

  /** The libraries the app can find, by the user's choice, else beside playerglobal.abc, else the checkout's builtin.abc. */
  libraries(): LibraryState {
    const playerglobal = this.found(this.current.playerglobal);
    const besideIt = playerglobal ? join(dirname(playerglobal), "builtin.abc") : undefined;
    const builtin =
      this.found(this.current.builtin) ?? this.found(besideIt) ?? this.found(checkoutBuiltin);
    return { builtin, playerglobal };
  }

  /** Whether it was saved; it holds for this run either way. */
  setLibrary(name: LibraryName, path: string): boolean {
    return this.update({ [name]: path });
  }

  /** `path` opened: first in the recent list. */
  opened(path: string): void {
    this.update({
      recent: [path, ...this.current.recent.filter((p) => p !== path)].slice(0, RECENT),
    });
  }

  /** Whether `swf` is always allowed a socket to `endpoint`, "host:port". */
  socketAllowed(swf: string, endpoint: string): boolean {
    return Object.hasOwn(this.current.sockets, swf) && this.current.sockets[swf].includes(endpoint);
  }

  /** Allow `swf` a socket to `endpoint` from now on: whether that was saved. */
  allowSocket(swf: string, endpoint: string): boolean {
    const allowed = Object.hasOwn(this.current.sockets, swf) ? this.current.sockets[swf] : [];
    return this.update({ sockets: { ...this.current.sockets, [swf]: [...allowed, endpoint] } });
  }

  clearRecent(): void {
    this.update({ recent: [] });
  }

  private found(path: string | undefined): string | null {
    return path && existsSync(path) ? path : null;
  }

  private read(): Settings {
    try {
      const read = JSON.parse(readFileSync(this.path, "utf8"));
      const text = (value: unknown) => (typeof value === "string" ? value : undefined);
      return {
        playerglobal: text(read.playerglobal),
        builtin: text(read.builtin),
        recent: strings(read.recent),
        sockets: Object.fromEntries(
          Object.entries(
            typeof read.sockets === "object" && read.sockets !== null ? read.sockets : {},
          ).map(([swf, endpoints]) => [swf, strings(endpoints)]),
        ),
      };
    } catch {
      // None yet, or unreadable: start again rather than refuse to start.
      return { recent: [], sockets: {} };
    }
  }

  /**
   * Apply `change`, and write the settings: whether they were written. A
   * user data directory that cannot be written keeps them for this run.
   */
  private update(change: Partial<Settings>): boolean {
    this.current = { ...this.current, ...change };
    // Written whole and renamed into place, so a crash never leaves half a
    // file, under a name no other write shares.
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(this.current, null, 2)}\n`);
      renameSync(temporary, this.path);
      return true;
    } catch (error) {
      console.error(`swf2es: settings not saved to ${this.path}: ${error}`);
      rmSync(temporary, { force: true });
      return false;
    }
  }
}
