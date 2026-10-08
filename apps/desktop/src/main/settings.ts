// What the app remembers between runs, in settings.json under its user
// data: where the user's libraries are, and the SWFs opened last.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LibraryName, LibraryState } from "../shared/api.js";

export interface Settings {
  playerglobal?: string;
  builtin?: string;
  /** Most recent first. */
  recent: string[];
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

  setLibrary(name: LibraryName, path: string): void {
    this.update({ [name]: path });
  }

  /** `path` opened: first in the recent list. */
  opened(path: string): void {
    this.update({
      recent: [path, ...this.current.recent.filter((p) => p !== path)].slice(0, RECENT),
    });
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
        recent: Array.isArray(read.recent)
          ? read.recent.filter((p: unknown) => typeof p === "string")
          : [],
      };
    } catch {
      // None yet, or unreadable: start again rather than refuse to start.
      return { recent: [] };
    }
  }

  private update(change: Partial<Settings>): void {
    this.current = { ...this.current, ...change };
    // Written whole and renamed into place, so a crash never leaves half a file.
    const temporary = `${this.path}.tmp`;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(this.current, null, 2)}\n`);
    renameSync(temporary, this.path);
  }
}
