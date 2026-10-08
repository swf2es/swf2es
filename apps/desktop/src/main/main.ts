// The desktop app's main process: one window on swf2es://app/, the menu,
// the files the user opens, the libraries they point at, and the page's
// few requests (shared/api.ts), each checked to come from that page.
//
//   electron apps/desktop [--trace] [file.swf | http(s)://host/movie.swf]
import { statSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
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
  session,
  shell,
  type WebContents,
} from "electron";
import type { LibraryName, NetworkResponse, OpenedMovie, StartState } from "../shared/api.js";
import { type Movie, Network, Refused } from "./network.ts";
import { APP_ORIGIN, registerScheme, serve } from "./protocol.ts";
import { Sandbox } from "./sandbox.ts";
import { SettingsFile } from "./settings.ts";
import { bridgeSockets } from "./sockets.ts";

const preload = fileURLToPath(new URL("../preload/preload.cjs", import.meta.url));
const promptPreload = fileURLToPath(new URL("../preload/prompt.cjs", import.meta.url));
const PROMPT_URL = `${APP_ORIGIN}/open-url.html`;
const TITLE = "swf2es";

// The tests keep their settings apart from the user's.
const userData = process.env.SWF2ES_DESKTOP_USER_DATA;
if (userData) {
  app.setPath("userData", userData);
}

registerScheme();
app.enableSandbox();

/** --trace: what the page logs, a SWF's trace() among it, goes to the terminal. */
const trace = process.argv.includes("--trace");
const sandbox = new Sandbox();
/** The SWF's http and https requests, judged as Flash's sandboxes had them. */
const network = new Network();
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

/** Open what the recent list, the command line or a reload names: a URL or a file's path. */
function openEntry(entry: string): Promise<void> {
  return remoteUrl(entry) ? openUrl(entry) : open(entry);
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
    window.setTitle(`${movie.name} — ${TITLE}`);
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

  sandbox.playRemote(url.href);
  show(url.href, { url: url.href, name, sandbox: "remote" }, { kind: "remote", url: url.href });
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
    title: "Open a SWF",
    properties: ["openFile"],
    filters: [
      { name: "SWF", extensions: ["swf"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!result.canceled && result.filePaths[0]) {
    await open(result.filePaths[0]);
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
          label: "&Close Movie",
          accelerator: "CmdOrCtrl+W",
          enabled: !!current,
          click: closeMovie,
        },
        { type: "separator" },
        { label: "Choose playerglobal.abc…", click: () => void chooseLibrary("playerglobal") },
        { label: "Choose builtin.abc…", click: () => void chooseLibrary("builtin") },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "&View",
      submenu: [
        {
          label: "&Reload Movie",
          accelerator: "CmdOrCtrl+R",
          enabled: !!current,
          click: () => current && void openEntry(current.path),
        },
        { role: "togglefullscreen", accelerator: "F11" },
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
  ipcMain.handle("desktop:start", (event): StartState => {
    if (!trusted(event)) {
      throw new Error("not the app's page");
    }

    listening = true;
    return { libraries: settings.libraries(), movie: current?.movie ?? null };
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
      void open(path);
    }
  });
  ipcMain.on("desktop:choose-library", (event, name: unknown) => {
    if (trusted(event) && (name === "builtin" || name === "playerglobal")) {
      void chooseLibrary(name);
    }
  });
  bridgeSockets(trusted, permitSocket);
  ipcMain.handle("net:fetch", (event, id: unknown, request: unknown) => {
    if (!trusted(event) || typeof id !== "number") {
      throw new Error("not the app's page");
    }

    // A refusal is an answer, not an error, which Electron would print as one.
    return fetchForPage(id, request).then(
      (response) => ({ response }),
      () => ({ response: null }),
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
}

/**
 * A request of the page's: the SWF's own, as the movie opened by its URL,
 * or what the SWF playing loads, only with the network, as network.ts
 * judges it. A refusal is said on stderr, and the page sees a failed
 * load.
 */
async function fetchForPage(id: number, request: unknown): Promise<NetworkResponse> {
  const asked = request as { url?: unknown; purpose?: unknown } | null;
  const url = typeof asked?.url === "string" ? asked.url : "";
  const shown = url.slice(0, 2048);
  const movie = asked?.purpose === "movie" && sandbox.startRemote(url);
  if (!movie && !sandbox.networkAllowed()) {
    process.stderr.write(`swf2es: not loading ${shown}: the SWF has no network\n`);
    throw new Refused("the SWF has no network");
  }

  const controller = new AbortController();
  requests.set(id, controller);
  try {
    return await network.fetch(request, controller.signal);
  } catch (error) {
    // A refusal says why; anything else, which should not happen, is said too.
    if (!controller.signal.aborted) {
      const why = error instanceof Refused ? error.message : `failed: ${error}`;
      process.stderr.write(`swf2es: not loading ${shown}: ${why}\n`);
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

  const entry = movieFromArguments(argv, workingDirectory);
  if (entry && settings) {
    void openEntry(entry);
  }
});

let pending = movieFromArguments(process.argv);
// macOS hands a file opened from the Finder as an event, perhaps before the app is ready.
app.on("open-file", (event, path) => {
  event.preventDefault();
  if (settings) {
    void open(path);
  } else {
    pending = path;
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
  if (pending) {
    void openEntry(pending);
  }
});
