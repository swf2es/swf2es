// The desktop app's main process: one window on swf2es://app/, the menu,
// the files the user opens, the libraries they point at, and the page's
// few requests (shared/api.ts), each checked to come from that page.
//
//   electron apps/desktop [--trace] [file.swf | http(s)://host/movie.swf]
//   electron apps/desktop [--trace] app.xml [root-dir] [-- arguments...]
//
// --ignore-certificate-errors[=host,...] leaves HTTPS certificates unchecked.
//
// The second runs an AIR application by its descriptor, as adl does.
import { statSync } from "node:fs";
import { open as openFile, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileAttributes } from "@swf2es/format";
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  safeStorage,
  session,
  shell,
  type WebContents,
} from "electron";
import type {
  AirWindowState,
  LibraryName,
  NetworkResponse,
  OpenedMovie,
  StartState,
} from "../shared/api.js";
import {
  type AirCommand,
  airCommand,
  airLaunch,
  createDirectoryOf,
  EncryptedItems,
  listOf,
  moveOf,
  readOf,
  removeOf,
  statOf,
  writeOf,
} from "./air.ts";
import { bridgeFiles } from "./files.ts";
import { failureLine, requestLine } from "./netlog.ts";
import { type Movie, Network, Refused, unverifiedHosts } from "./network.ts";
import { APP_ORIGIN, registerScheme, serve } from "./protocol.ts";
import { Sandbox } from "./sandbox.ts";
import { SettingsFile } from "./settings.ts";
import { bridgeSockets } from "./sockets.ts";

const preload = fileURLToPath(new URL("../preload/preload.cjs", import.meta.url));
const promptPreload = fileURLToPath(new URL("../preload/prompt.cjs", import.meta.url));
// The window's and the taskbar's icon, the project's, where the platform takes one from the window.
const icon = fileURLToPath(new URL("../../static/icon.png", import.meta.url));
const PROMPT_URL = `${APP_ORIGIN}/open-url.html`;
const TITLE = "swf2es";

// The tests keep their settings apart from the user's.
const userData = process.env.SWF2ES_DESKTOP_USER_DATA;
if (userData) {
  app.setPath("userData", userData);
}

// launch.ts's commit; a test or another launcher gives none.
const build = /^[\w.+-]{1,40}$/.test(process.env.SWF2ES_DESKTOP_BUILD ?? "")
  ? (process.env.SWF2ES_DESKTOP_BUILD as string)
  : null;

registerScheme();
app.enableSandbox();

/** --trace: what the page logs, a SWF's trace() among it, goes to the terminal. */
const trace = process.argv.includes("--trace");
// Each request and socket of the SWF's said on stderr: the page's DevTools show none of them.
const logNetwork = process.argv.includes("--log-network");
const netLog = logNetwork ? (line: string) => process.stderr.write(`${line}\n`) : null;
const sandbox = new Sandbox();
/** The SWF's http and https requests, judged as Flash's sandboxes had them. */
/**
 * --ignore-certificate-errors[=host,...]: HTTPS servers whose certificates go
 * unchecked, for one's own with a certificate it signed itself. For this
 * run alone, never kept, and said aloud: anyone on the way to such a host
 * can read and change what the SWF loads from it.
 */
const unverified = unverifiedHosts(process.argv.slice(1));
if (unverified) {
  process.stderr.write(
    unverified.all
      ? "swf2es: --ignore-certificate-errors: no HTTPS server's certificate is verified\n"
      : `swf2es: --ignore-certificate-errors: certificates are not verified for ${unverified.hosts.join(", ") || "no host"}\n`,
  );
}

const network = new Network({
  unverified: (host) =>
    !!unverified && (unverified.all || unverified.hosts.includes(host.toLowerCase())),
});
/** What the page's requests under way abort with, by the preload's number. */
const requests = new Map<number, AbortController>();
let settings: SettingsFile;
/** What the network judges the movie playing as; null for none, or one without networking. */
let networkMovie: Movie | null = null;
let window: BrowserWindow | null = null;
/** The dialog that asks for a URL, while it is open. */
let prompt: BrowserWindow | null = null;
let current: { path: string; movie: OpenedMovie } | null = null;
/** The servers the SWF playing was allowed, or denied, a socket to until it closes: "host:port". */
let allowedOnce = new Set<string>();
let deniedOnce = new Set<string>();
/** The prompts on screen, by "host:port": a second connection there waits on the first's answer. */
const asking = new Map<string, Promise<boolean>>();
/**
 * The page has asked to start and listens for what opens: until then, start() hands it the movie.
 */
let listening = false;

/** The longest URL a SWF is opened by. */
const MAX_URL = 8192;
/** The AIR application playing, as its command line asked for it; null for none. */
let air: AirCommand | null = null;
/** The EncryptedLocalStore of the AIR application playing, if one is. */
let encryptedItems: EncryptedItems | null = null;

/**
 * `text` as the URL of a remote SWF: http or https, with a host and no
 * credentials, its fragment dropped; null if it is not one.
 */
function remoteUrl(text: string): URL | null {
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
function movieFromArguments(argv: string[], cwd = process.cwd()): string | null {
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

/** Whether a message comes from the window's own page, on swf2es://app/. */
function trusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    window !== null &&
    event.sender === window.webContents &&
    frame !== null &&
    frame.parent === null &&
    // Node's URL gives a scheme it does not know no origin: compare the text.
    frame.url.startsWith(`${APP_ORIGIN}/`)
  );
}

/** How long after a click or a key a SWF may open a page: Chromium's transient activation. */
const GESTURE_MS = 5000;
/** The least time between two pages opened, whatever the gestures. */
const OPEN_INTERVAL_MS = 1000;
const GESTURES = new Set(["mouseDown", "rawKeyDown", "keyDown", "touchEnd", "gestureTap"]);
/** When the user last clicked or pressed a key in the window, and when a page last opened. */
let gestureAt = Number.NEGATIVE_INFINITY;
let openedAt = Number.NEGATIVE_INFINITY;

/**
 * An http(s) URL in the system's browser, never in the app, only for a SWF
 * with the network (local-with-networking or remote), and only as a click
 * or a key asked: one page a gesture, a second apart at least, as a
 * browser's popup blocker allows, so a SWF cannot launch the browser in a
 * loop. Anything else goes nowhere.
 */
function openExternal(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return;
  }

  const now = performance.now();
  if (protocol !== "https:" && protocol !== "http:") {
    return;
  }

  // Flash refused a local-with-filesystem SWF the network, navigateToURL
  // among it: a page opened with what it read in its URL would send it away.
  if (!sandbox.networkAllowed()) {
    process.stderr.write(`swf2es: not opening ${url}: the SWF has no network\n`);
    return;
  }

  if (now - gestureAt > GESTURE_MS || now - openedAt < OPEN_INTERVAL_MS) {
    process.stderr.write(`swf2es: not opening ${url}: no click or key asked for it\n`);
    return;
  }

  gestureAt = Number.NEGATIVE_INFINITY;
  openedAt = now;
  void shell.openExternal(url);
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
async function readStart(path: string, length: number, least = 8): Promise<Uint8Array | null> {
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

function refuse(message: string, detail: string): void {
  if (window) {
    void dialog.showMessageBox(window, { type: "error", message, detail });
  }
}

/** Open what the recent list, the command line or a reload names: a URL, a SWF's path or a descriptor's. */
function openEntry(entry: string): Promise<void> {
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
async function openAir(command: AirCommand, cwd: string): Promise<void> {
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
async function openUrl(text: string): Promise<void> {
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
async function openChosen(path: string): Promise<void> {
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

function closeMovie(): void {
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

/**
 * Whether the SWF playing may connect a socket to `host`:`port`, and where
 * to: only with the network, and only as the user allows, once or always
 * for that SWF, when it first asks for that server; and for a remote SWF,
 * as that server's socket policy allows, at the address it came from.
 * Denied where no one can be asked.
 */
async function permitSocket(host: string, port: number): Promise<{ address?: string } | null> {
  // AIR's application sandbox connects where it likes, unasked, with no socket policy.
  if (sandbox.application) {
    return {};
  }

  const playing = current;
  const swf = sandbox.swf;
  const endpoint = `${host}:${port}`;
  if (!playing || !swf || !sandbox.networkAllowed()) {
    process.stderr.write(`swf2es: no socket to ${endpoint}: the SWF has no network\n`);
    return null;
  }

  if (!(await allowedByUser(playing, swf, endpoint))) {
    return null;
  }

  if (networkMovie?.kind !== "remote") {
    return {};
  }

  try {
    return { address: await network.socketAddress(host, port) };
  } catch (error) {
    process.stderr.write(`swf2es: no socket to ${endpoint}: ${(error as Error).message}\n`);
    return null;
  }
}

/** Whether the user allows the SWF playing a socket to `endpoint`, asked once a server. */
async function allowedByUser(
  playing: NonNullable<typeof current>,
  swf: string,
  endpoint: string,
): Promise<boolean> {
  if (settings.socketAllowed(swf, endpoint) || allowedOnce.has(endpoint)) {
    return true;
  }

  if (deniedOnce.has(endpoint)) {
    return false;
  }

  let answer = asking.get(endpoint);
  if (!answer) {
    answer = askForSocket(playing.movie.name, swf, endpoint).finally(() => asking.delete(endpoint));
    asking.set(endpoint, answer);
  }

  return (await answer) && current === playing;
}

async function askForSocket(name: string, swf: string, endpoint: string): Promise<boolean> {
  if (!window) {
    return false;
  }

  const playing = current;
  let response: number;
  try {
    ({ response } = await dialog.showMessageBox(window, {
      type: "question",
      message: `${name} asks to connect to ${endpoint}.`,
      detail:
        "A socket lets the SWF send that server whatever it has. " +
        "Allow it only for a server you trust.",
      buttons: ["Allow Once", "Always Allow for This SWF", "Deny"],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
    }));
  } catch {
    return false;
  }

  if (current !== playing) {
    return false;
  }

  switch (response) {
    case 0:
      allowedOnce.add(endpoint);
      return true;
    case 1:
      if (!settings.allowSocket(swf, endpoint)) {
        allowedOnce.add(endpoint);
      }

      return true;
    default:
      deniedOnce.add(endpoint);
      return false;
  }
}

async function showOpenDialog(): Promise<void> {
  if (!window) {
    return;
  }

  const result = await dialog.showOpenDialog(window, {
    title: "Open a SWF or an AIR application",
    properties: ["openFile"],
    filters: [
      { name: "SWF and AIR application descriptors", extensions: ["swf", "xml"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!result.canceled && result.filePaths[0]) {
    await openChosen(result.filePaths[0]);
  }
}

/** Ask for a library, check that it is ABC, keep its path, and start the page again with it. */
async function chooseLibrary(name: LibraryName): Promise<void> {
  if (!window) {
    return;
  }

  const result = await dialog.showOpenDialog(window, {
    title: `Choose ${name}.abc`,
    properties: ["openFile"],
    filters: [
      { name: "ActionScript bytecode", extensions: ["abc"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  const path = result.filePaths[0];
  if (result.canceled || !path) {
    return;
  }

  // An ABC starts with its minor version, then its major one, 46.
  const head = await readStart(path, 4);
  if (head?.[2] !== 46 || head[3] !== 0) {
    refuse(`${basename(path)} is not an ABC file.`, `swf2es needs ${name}.abc itself.`);
    return;
  }

  if (!settings.setLibrary(name, path)) {
    refuse("The settings could not be saved.", `swf2es uses ${path} until it quits.`);
  }

  // The page fetched the libraries once; a fresh page fetches the new one.
  window.webContents.reload();
}

function buildMenu(): void {
  const recent = settings.settings.recent;
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "&File",
      submenu: [
        { label: "&Open…", accelerator: "CmdOrCtrl+O", click: () => void showOpenDialog() },
        { label: "Open &URL…", accelerator: "CmdOrCtrl+L", click: showUrlDialog },
        {
          label: "Open &Recent",
          submenu: [
            ...recent.map((entry) => ({ label: entry, click: () => void openEntry(entry) })),
            ...(recent.length > 0 ? [{ type: "separator" as const }] : []),
            {
              label: "Clear Recent",
              enabled: recent.length > 0,
              click: () => {
                settings.clearRecent();
                app.clearRecentDocuments();
                buildMenu();
              },
            },
          ],
        },
        {
          id: "close-movie",
          label: "&Close Movie",
          accelerator: "CmdOrCtrl+W",
          enabled: !!current,
          click: closeMovie,
        },
        { type: "separator" },
        { label: "Choose playerglobal.abc…", click: () => void chooseLibrary("playerglobal") },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "&View",
      submenu: [
        {
          id: "reload-movie",
          label: "&Reload Movie",
          accelerator: "CmdOrCtrl+R",
          enabled: !!current,
          click: () => current && void openEntry(current.path),
        },
        { role: "togglefullscreen", accelerator: "F11" },
        { type: "separator" },
        {
          id: "stage3d",
          label: "Stage3D (Experimental)",
          type: "checkbox",
          checked: settings.settings.stage3D,
          click: (item) => {
            if (!settings.setStage3D(item.checked)) {
              refuse(
                "The settings could not be saved.",
                "The Stage3D choice holds until you quit.",
              );
            }

            window?.webContents.reload();
          },
        },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * The window's page may go nowhere but swf2es://app/, and open nothing but the system's browser.
 */
function guard(contents: WebContents): void {
  contents.on("will-navigate", (event) => {
    event.preventDefault();
    openExternal(event.url);
  });
  contents.on("input-event", (_event, input) => {
    if (GESTURES.has(input.type)) {
      gestureAt = performance.now();
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      listening = false;
      // The page's requests go with it; the next page asks for the movie again.
      network.play(networkMovie);
      requests.clear();
    }
  });
  if (trace) {
    contents.on("console-message", ({ level, message }) => {
      // A SWF's trace() is console.log's; warnings and errors are the page's own.
      (level === "info" ? process.stdout : process.stderr).write(`${message}\n`);
    });
  }
}

/**
 * The dialog that asks for a SWF's URL: a window of its own, apart from the
 * page, so that only the user, and never a SWF, opens one by its URL.
 */
function showUrlDialog(): void {
  if (!window) {
    return;
  }

  if (prompt) {
    prompt.focus();
    return;
  }

  const dialogWindow = new BrowserWindow({
    parent: window,
    modal: true,
    width: 560,
    height: 180,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Open URL",
    show: false,
    webPreferences: {
      preload: promptPreload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  prompt = dialogWindow;
  dialogWindow.setMenu(null);
  dialogWindow.on("page-title-updated", (event) => event.preventDefault());
  dialogWindow.once("ready-to-show", () => dialogWindow.show());
  dialogWindow.on("closed", () => {
    if (prompt === dialogWindow) {
      prompt = null;
    }
  });
  const contents = dialogWindow.webContents;
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  void dialogWindow.loadURL(PROMPT_URL);
}

/** Whether a message comes from the URL dialog's own page. */
function fromPrompt(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    prompt !== null &&
    event.sender === prompt.webContents &&
    frame !== null &&
    frame.parent === null &&
    frame.url === PROMPT_URL
  );
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1024,
    height: 768,
    title: TITLE,
    icon,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  // The title is the movie's, set here, not the page's <title>.
  window.on("page-title-updated", (event) => event.preventDefault());
  window.on("closed", () => {
    window = null;
  });
  guard(window.webContents);
  void window.loadURL(`${APP_ORIGIN}/`);
}

function listen(): void {
  bridgeFiles(
    trusted,
    () => window,
    () => {
      if (performance.now() - gestureAt > GESTURE_MS) {
        return false;
      }

      gestureAt = Number.NEGATIVE_INFINITY;
      return true;
    },
    { ipcMain, dialog },
  );
  ipcMain.handle("desktop:start", (event): StartState => {
    if (!trusted(event)) {
      throw new Error("not the app's page");
    }

    listening = true;
    return {
      stage3D: settings.settings.stage3D,
      libraries: settings.libraries(),
      movie: current?.movie ?? null,
      build,
    };
  });
  ipcMain.on("desktop:open-dialog", (event) => {
    if (trusted(event)) {
      void showOpenDialog();
    }
  });
  ipcMain.on("desktop:open-url-dialog", (event) => {
    if (trusted(event)) {
      showUrlDialog();
    }
  });
  ipcMain.handle("prompt:initial", (event) => {
    if (!fromPrompt(event)) {
      throw new Error("not the URL dialog");
    }

    // What plays, if it came by a URL, for the user to change.
    return current && remoteUrl(current.path) ? current.path : "";
  });
  ipcMain.on("prompt:answer", (event, text: unknown) => {
    if (!fromPrompt(event)) {
      return;
    }

    prompt?.close();
    if (typeof text === "string" && text.trim() !== "") {
      void openUrl(text);
    }
  });
  ipcMain.on("desktop:open-path", (event, path: unknown) => {
    if (trusted(event) && typeof path === "string" && isAbsolute(path)) {
      void openChosen(path);
    }
  });
  ipcMain.on("desktop:choose-library", (event, name: unknown) => {
    if (trusted(event) && name === "playerglobal") {
      void chooseLibrary(name);
    }
  });
  bridgeSockets(trusted, permitSocket, netLog);
  ipcMain.handle("net:fetch", (event, id: unknown, request: unknown) => {
    if (!trusted(event) || typeof id !== "number") {
      throw new Error("not the app's page");
    }

    // The response goes as a message of its own, copied as it is sent, so
    // that its bytes count against the movie's budget until then; the answer
    // says whether it went. A refusal is an answer, not an error, which
    // Electron would print as one.
    const contents = event.sender;
    const deliver = (response: NetworkResponse) => {
      if (!contents.isDestroyed()) {
        contents.send("net:response", id, response);
      }
    };
    return fetchForPage(id, request, deliver).then(
      () => ({ delivered: true }),
      () => ({ delivered: false }),
    );
  });
  ipcMain.on("net:abort", (event, id: unknown) => {
    if (trusted(event) && typeof id === "number") {
      requests.get(id)?.abort();
    }
  });
  ipcMain.on("net:policy-file", (event, url: unknown) => {
    if (trusted(event) && sandbox.networkAllowed()) {
      network.addPolicyFile(url);
    }
  });
  listenForAir();
}

/** The window as an AIR application's NativeWindow reads it. */
function windowState(w: BrowserWindow): AirWindowState {
  const bounds = w.getBounds();
  const content = w.getContentBounds();
  return {
    bounds,
    contentOffset: { x: content.x - bounds.x, y: content.y - bounds.y },
    title: w.getTitle(),
    displayState: w.isMinimized() ? "minimized" : w.isMaximized() ? "maximized" : "normal",
    active: w.isFocused(),
    visible: w.isVisible(),
  };
}

/**
 * An AIR application's reach, shared/api.ts DesktopAir: the file system
 * and the window, only while one the user opened plays and only for its
 * page. The file system is read synchronously where File reads it so.
 */
function listenForAir(): void {
  const playing = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    trusted(event) && sandbox.application;
  ipcMain.on("air:stat", (event, path: unknown) => {
    event.returnValue = playing(event) && typeof path === "string" ? statOf(path) : null;
  });
  ipcMain.on("air:list", (event, path: unknown) => {
    event.returnValue = playing(event) && typeof path === "string" ? listOf(path) : null;
  });
  // FileStream's open, which reads a file at once, as stat does: only once the application plays.
  ipcMain.on("air:read-sync", (event, path: unknown) => {
    event.returnValue = playing(event) && typeof path === "string" ? readOf(path) : null;
  });
  // EncryptedLocalStore, at once as its methods are: only the application playing's.
  const items = (event: IpcMainEvent) => (playing(event) ? encryptedItems : null);
  ipcMain.on("air:item-get", (event, name: unknown) => {
    event.returnValue = typeof name === "string" ? (items(event)?.get(name) ?? null) : null;
  });
  ipcMain.on("air:item-set", (event, name: unknown, bytes: unknown) => {
    if (typeof name === "string" && bytes instanceof Uint8Array) {
      items(event)?.set(name, bytes);
    }

    event.returnValue = null;
  });
  ipcMain.on("air:item-remove", (event, name: unknown) => {
    if (typeof name === "string") {
      items(event)?.remove(name);
    }

    event.returnValue = null;
  });
  ipcMain.on("air:items-reset", (event) => {
    items(event)?.reset();
    event.returnValue = null;
  });
  // FileStream's writes and File's changes, at once as adl's: only once the application plays.
  ipcMain.on(
    "air:write-sync",
    (event, path: unknown, bytes: unknown, offset: unknown, length: unknown) => {
      event.returnValue =
        playing(event) &&
        typeof path === "string" &&
        bytes instanceof Uint8Array &&
        Number.isSafeInteger(offset) &&
        Number.isSafeInteger(length) &&
        (offset as number) >= 0 &&
        (length as number) >= 0 &&
        writeOf(path, bytes, offset as number, length as number);
    },
  );
  ipcMain.on("air:create-directory", (event, path: unknown) => {
    event.returnValue = playing(event) && typeof path === "string" && createDirectoryOf(path);
  });
  ipcMain.on("air:remove", (event, path: unknown) => {
    event.returnValue = playing(event) && typeof path === "string" && removeOf(path);
  });
  ipcMain.on("air:move", (event, from: unknown, to: unknown) => {
    event.returnValue =
      playing(event) && typeof from === "string" && typeof to === "string" && moveOf(from, to);
  });
  // A read is what starts the application's grant: the page reads its content SWF first.
  ipcMain.handle("air:read", async (event, path: unknown) => {
    if (!trusted(event) || typeof path !== "string" || !air) {
      return null;
    }

    try {
      const real = await realpath(path);
      return sandbox.startApplication(real) ? new Uint8Array(await readFile(real)) : null;
    } catch {
      return null;
    }
  });
  ipcMain.on("air:window", (event) => {
    event.returnValue = playing(event) && window ? windowState(window) : null;
  });
  ipcMain.on("air:set-bounds", (event, bounds: unknown) => {
    const b = bounds as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
    const [x, y, width, height] = [n(b?.x), n(b?.y), n(b?.width), n(b?.height)];
    if (
      playing(event) &&
      window &&
      x !== null &&
      y !== null &&
      width &&
      height &&
      width > 0 &&
      height > 0
    ) {
      window.setBounds({ x, y, width, height });
    }
  });
  ipcMain.on("air:set-title", (event, title: unknown) => {
    if (playing(event) && window && typeof title === "string") {
      window.setTitle(title.slice(0, 1024));
    }
  });
  ipcMain.on("air:window-do", (event, what: unknown) => {
    if (!playing(event) || !window) {
      return;
    }

    switch (what) {
      case "minimize":
        window.minimize();
        break;
      case "maximize":
        window.maximize();
        break;
      case "restore":
        window.restore();
        break;
      case "activate":
        window.focus();
        break;
      case "show":
        window.show();
        break;
      case "hide":
        window.hide();
        break;
      case "close":
        window.close();
        break;
    }
  });
  ipcMain.on("air:exit", (event, code: unknown) => {
    if (playing(event)) {
      app.exit(typeof code === "number" ? code | 0 : 0);
    }
  });
}

/**
 * A request of the page's: the SWF's own, as the movie opened by its URL,
 * or what the SWF playing loads, only with the network, as network.ts
 * judges it. A refusal is said on stderr, and the page sees a failed
 * load.
 */
async function fetchForPage(
  id: number,
  request: unknown,
  deliver: (response: NetworkResponse) => void,
): Promise<NetworkResponse> {
  const asked = request as { url?: unknown; purpose?: unknown; method?: unknown } | null;
  const url = typeof asked?.url === "string" ? asked.url : "";
  const shown = url.slice(0, 2048);
  const movie = asked?.purpose === "movie" && sandbox.startRemote(url);
  if (!movie && !sandbox.networkAllowed()) {
    process.stderr.write(`swf2es: not loading ${shown}: the SWF has no network\n`);
    throw new Refused("the SWF has no network");
  }

  const controller = new AbortController();
  requests.set(id, controller);
  const started = performance.now();
  const method = typeof asked?.method === "string" ? asked.method.slice(0, 16) : "GET";
  try {
    const response = await network.fetch(request, controller.signal, deliver);
    netLog?.(
      requestLine(
        method,
        url,
        response.status,
        response.bytes?.length ?? null,
        performance.now() - started,
      ),
    );
    return response;
  } catch (error) {
    // A refusal says why; anything else, which should not happen, is said too.
    if (!controller.signal.aborted) {
      const why = error instanceof Refused ? error.message : `failed: ${error}`;
      process.stderr.write(`swf2es: not loading ${shown}: ${why}\n`);
    } else {
      netLog?.(failureLine(method, url, "aborted", performance.now() - started));
    }

    throw error;
  } finally {
    if (requests.get(id) === controller) {
      requests.delete(id);
    }
  }
}

// One app to a user data directory: a second start hands its SWF to the first and quits.
const first = app.requestSingleInstanceLock();
if (!first) {
  app.quit();
}

app.on("second-instance", (_event, argv, workingDirectory) => {
  if (window) {
    if (window.isMinimized()) {
      window.restore();
    }

    window.focus();
  }

  const application = airCommand(argv.slice(1), workingDirectory);
  if (application && settings) {
    void openAir(application, workingDirectory);
    return;
  }

  const entry = movieFromArguments(argv, workingDirectory);
  if (entry && settings) {
    void openEntry(entry);
  }
});

let pending = movieFromArguments(process.argv);
// Whether `pending` came from the system's "open with", not the command line: asked as a drop is.
let pendingChosen = false;
// An AIR application named adl's way, which the command line's SWF gives way to.
const pendingAir = airCommand(process.argv.slice(process.defaultApp ? 2 : 1), process.cwd());
// macOS hands a file opened from the Finder as an event, perhaps before the app is ready.
app.on("open-file", (event, path) => {
  event.preventDefault();
  if (settings) {
    void openChosen(path);
  } else {
    pending = path;
    pendingChosen = true;
  }
});

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

app.on("window-all-closed", () => app.quit());

// Not awaited at the top level: Electron makes the app ready only once the main module has run.
void app.whenReady().then(() => {
  if (!first) {
    return;
  }

  settings = new SettingsFile(app.getPath("userData"));
  serve(session.defaultSession, sandbox, () => settings.libraries());
  // The page never goes to the network itself: a SWF's requests go through
  // the main process (network.ts), which sends them without this session.
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
    (details, answer) => {
      process.stderr.write(`swf2es: not loading ${details.url}: the page has no network\n`);
      answer({ cancel: true });
    },
  );
  // Only what the player needs that the page cannot simply have: full screen.
  session.defaultSession.setPermissionRequestHandler((contents, permission, answer) =>
    answer(permission === "fullscreen" && contents === window?.webContents),
  );
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission) => permission === "fullscreen" && contents === window?.webContents,
  );
  listen();
  createWindow();
  buildMenu();
  if (pendingAir) {
    void openAir(pendingAir, process.cwd());
  } else if (pending) {
    void (pendingChosen ? openChosen(pending) : openEntry(pending));
  }
});
