// What plays, and opening it: a SWF by its path or its URL, or an AIR
// application by its descriptor, from the command line, the menu, a
// dialog or a drop; and closing it. Only this module changes what plays;
// the others read it.
import { statSync } from "node:fs";
import { open as openFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileAttributes } from "@swf2es/format";
import { app, dialog, safeStorage } from "electron";
import type { OpenedMovie } from "../shared/api.js";
import { type AirCommand, airLaunch, EncryptedItems } from "./air.ts";
import { refuse } from "./dialogs.ts";
import { buildMenu } from "./menu.ts";
import type { Movie } from "./network-types.ts";
import { listening, sandbox, settings, TITLE, window } from "./state.ts";
import { network } from "./switches.ts";

/** What the network judges the movie playing as; null for none, or one without networking. */
export let networkMovie: Movie | null = null;
export let current: { path: string; movie: OpenedMovie } | null = null;
/** The servers the SWF playing was allowed, or denied, a socket to until it closes: "host:port". */
export let allowedOnce = new Set<string>();
export let deniedOnce = new Set<string>();

/** The longest URL a SWF is opened by. */
const MAX_URL = 8192;
/** The AIR application playing, as its command line asked for it; null for none. */
export let air: AirCommand | null = null;
/** The EncryptedLocalStore of the AIR application playing, if one is. */
export let encryptedItems: EncryptedItems | null = null;

/**
 * `text` as the URL of a remote SWF: http or https, with a host and no
 * credentials, its fragment dropped; null if it is not one.
 */
export function remoteUrl(text: string): URL | null {
  if (text.length > MAX_URL) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }

  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) {
    return null;
  }

  if (url.username || url.password) {
    return null;
  }

  url.hash = "";
  return url;
}

/**
 * The SWF named on a command line, from `cwd`: the last argument after the
 * app's own that is an http or https URL or names a .swf file there is.
 * Chromium's and Electron's switches may take values of their own
 * (`--switch value`), so the first argument that is not a switch could be one.
 */
export function movieFromArguments(argv: string[], cwd = process.cwd()): string | null {
  const named = argv
    .slice(process.defaultApp ? 2 : 1)
    .filter((a) => !a.startsWith("-"))
    .map((a) => remoteUrl(a)?.href ?? (/\.swf$/i.test(a) ? resolve(cwd, a) : null))
    .filter((a) => a !== null);
  return (
    named.reverse().find((a) => remoteUrl(a) || statSync(a, { throwIfNoEntry: false })?.isFile()) ??
    null
  );
}

/**
 * How much of a SWF the main process reads to choose its sandbox: far more than FileAttributes
 * takes compressed.
 */
const START = 64 * 1024;
const USE_NETWORK = 0x01;

/**
 * The first `length` bytes of the file at `path`, or as many as it has, at least `least`; null
 * otherwise.
 */
export async function readStart(
  path: string,
  length: number,
  least = 8,
): Promise<Uint8Array | null> {
  try {
    const file = await openFile(path);
    try {
      const bytes = new Uint8Array(length);
      const { bytesRead } = await file.read(bytes, 0, length, 0);
      return bytesRead >= Math.min(least, length) ? bytes.subarray(0, bytesRead) : null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/** Open what the recent list, the command line or a reload names: a URL, a SWF's path or a descriptor's. */
export function openEntry(entry: string): Promise<void> {
  if (remoteUrl(entry)) {
    return openUrl(entry);
  }

  // A descriptor reopened from the recent list or a reload, with the arguments it was run with.
  if (/\.xml$/i.test(entry)) {
    return openAir(
      air?.descriptor === entry ? air : { descriptor: entry, root: null, arguments: [] },
      process.cwd(),
    );
  }

  return open(entry);
}

/**
 * Run the AIR application `command` names, as adl does: its content SWF in
 * the window, at the descriptor's size, in AIR's application sandbox, with
 * its launch (shared/api.ts AirLaunch), from `cwd`.
 */
export async function openAir(command: AirCommand, cwd: string): Promise<void> {
  const name = basename(command.descriptor);
  let opened: ReturnType<typeof airLaunch>;
  try {
    opened = airLaunch(command, cwd, app.getPath("userData"), {
      documents: app.getPath("documents"),
      desktop: app.getPath("desktop"),
      cache: app.getPath("temp"),
    });
  } catch (error) {
    refuse(`${name} could not be opened.`, String(error));
    return;
  }

  const head = await readStart(opened.content, START);
  const signature = head ? String.fromCharCode(...head.subarray(0, 3)) : "";
  if (!head || (signature !== "FWS" && signature !== "CWS" && signature !== "ZWS")) {
    refuse(`${name}'s content is not a SWF.`, opened.content);
    return;
  }

  const content = await realpath(opened.content);
  sandbox.playApplication(content);
  air = command;
  // Beside its storage directory, by its id, as AIR keeps it; encrypted by the system's keychain where it has one.
  encryptedItems = new EncryptedItems(
    join(dirname(opened.launch.directories.applicationStorage), "EncryptedLocalStore"),
    safeStorage.isEncryptionAvailable()
      ? {
          encrypt: (text) => new Uint8Array(safeStorage.encryptString(text)),
          decrypt: (data) => safeStorage.decryptString(Buffer.from(data)),
        }
      : null,
  );
  if (window && opened.width && opened.height) {
    window.setSize(opened.width, opened.height);
  }

  // Played from app:/, as AIR plays it: its relative URLs, and loaderInfo.url, are the application's.
  const url = `app:/${opened.relative
    .split("/")
    .filter((s) => s !== "")
    .map(encodeURIComponent)
    .join("/")}`;
  show(
    command.descriptor,
    { url, name: opened.title, sandbox: "application", air: opened.launch },
    { kind: "application" },
  );
}

/** Play `movie` in the window, in place of what plays: what the user opened, as `entry`. */
function show(entry: string, movie: OpenedMovie, onNetwork: Movie | null): void {
  current = { path: entry, movie };
  playOnNetwork(onNetwork);
  allowedOnce = new Set();
  deniedOnce = new Set();
  settings.opened(entry);
  buildMenu();
  if (window) {
    // An AIR application's window is its own: its title alone, as adl shows it.
    window.setTitle(movie.air ? movie.name : `${movie.name} — ${TITLE}`);
    if (listening) {
      window.webContents.send("desktop:open", movie);
    }
  }
}

/**
 * Play the SWF at `text`, an http or https URL, in Flash's remote sandbox:
 * no local file, and the network as its origin's (network.ts). The page
 * fetches it through the main process like anything it loads.
 */
export async function openUrl(text: string): Promise<void> {
  const url = remoteUrl(text);
  if (!url) {
    refuse("Only an http or https URL opens.", text.slice(0, 200));
    return;
  }

  const last = url.pathname.split("/").pop() ?? "";
  let name: string;
  try {
    name = decodeURIComponent(last) || url.host;
  } catch {
    name = last;
  }

  air = null;
  sandbox.playRemote(url.href);
  show(url.href, { url: url.href, name, sandbox: "remote" }, { kind: "remote", url: url.href });
}

/**
 * Open the file the user chose in the dialog, dropped on the window or
 * opened with the app: an AIR application's descriptor (`.xml`) runs the
 * application, anything else is played as a SWF.
 */
export async function openChosen(path: string): Promise<void> {
  if (!/\.xml$/i.test(path)) {
    return open(path);
  }

  // An application has an installed program's reach, which a file chosen in
  // passing should not get unasked: asked once, until it leaves the recent list.
  if (window && !settings.settings.recent.includes(path)) {
    const { response } = await dialog.showMessageBox(window, {
      type: "question",
      message: `Run ${basename(path)} as an AIR application?`,
      detail:
        "An AIR application reads and writes your files and reaches the network unasked, as an installed program does. Run only one you trust.",
      buttons: ["Run", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (response !== 0) {
      return;
    }
  }

  // Run from its own directory, with no arguments, as one started by its icon is.
  return openAir({ descriptor: path, root: null, arguments: [] }, dirname(path));
}

/** Play the SWF at `path` in the window, in place of what plays, in its sandbox. */
async function open(path: string): Promise<void> {
  const name = basename(path);
  // Its start alone: the main process never decompresses a SWF whole, whose
  // header may name 4 GB. FileAttributes, the first tag, lies in it.
  const head = await readStart(path, START);
  const signature = head ? String.fromCharCode(...head.subarray(0, 3)) : "";
  if (!head || (signature !== "FWS" && signature !== "CWS" && signature !== "ZWS")) {
    refuse(`${name} is not a SWF.`, path);
    return;
  }

  const useNetwork = (fileAttributes(head) & USE_NETWORK) !== 0;

  let url: string;
  try {
    air = null;
    url = sandbox.play(path, useNetwork);
  } catch (error) {
    // Gone, or unreadable, since it was read.
    refuse(`${name} could not be opened.`, String(error));
    return;
  }

  app.addRecentDocument(path);
  show(
    path,
    { url, name, sandbox: useNetwork ? "localWithNetwork" : "localWithFile" },
    useNetwork ? { kind: "local" } : null,
  );
}

/** Judge requests for `movie` from now on: the last one's are aborted. */
function playOnNetwork(movie: Movie | null): void {
  networkMovie = movie;
  network.play(movie);
}

export function closeMovie(): void {
  current = null;
  air = null;
  sandbox.stop();
  playOnNetwork(null);
  buildMenu();
  window?.setTitle(TITLE);
  if (listening) {
    window?.webContents.send("desktop:close");
  }
}
