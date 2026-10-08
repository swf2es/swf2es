// The desktop app's main process: one window on swf2es://app/, the menu,
// the files the user opens, the libraries they point at, and the page's
// few requests (shared/api.ts), each checked to come from that page.
//
//   electron apps/desktop [--trace] [file.swf]
import { open as openFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import type { LibraryName, OpenedMovie, StartState } from "../shared/api.js";
import { APP_ORIGIN, FileGrants, registerScheme, serve } from "./protocol.js";
import { SettingsFile } from "./settings.js";
import { bridgeSockets } from "./sockets.js";

const preload = fileURLToPath(new URL("../preload/preload.cjs", import.meta.url));
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
const grants = new FileGrants();
let settings: SettingsFile;
let window: BrowserWindow | null = null;
let current: { path: string; movie: OpenedMovie } | null = null;
/** The page has asked to start and listens for what opens: until then, start() hands it the movie. */
let listening = false;

/** The SWF named on the command line: the first argument that is not a switch, after the app's own. */
function fileFromArguments(argv: string[]): string | null {
  const rest = argv.slice(process.defaultApp ? 2 : 1).filter((a) => !a.startsWith("-"));
  return rest.length > 0 ? resolve(rest[0]) : null;
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
 * An http(s) URL in the system's browser, never in the app, and only as a
 * click or a key asked: one page a gesture, a second apart at least, as a
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

  if (now - gestureAt > GESTURE_MS || now - openedAt < OPEN_INTERVAL_MS) {
    process.stderr.write(`swf2es: not opening ${url}: no click or key asked for it\n`);
    return;
  }

  gestureAt = Number.NEGATIVE_INFINITY;
  openedAt = now;
  void shell.openExternal(url);
}

async function readStart(path: string, length: number): Promise<Uint8Array | null> {
  try {
    const file = await openFile(path);
    try {
      const bytes = new Uint8Array(length);
      const { bytesRead } = await file.read(bytes, 0, length, 0);
      return bytesRead === length ? bytes : null;
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

/** Play the SWF at `path` in the window, in place of what plays. */
async function open(path: string): Promise<void> {
  const name = basename(path);
  const head = await readStart(path, 3);
  const signature = head ? String.fromCharCode(...head) : "";
  if (signature !== "FWS" && signature !== "CWS" && signature !== "ZWS") {
    refuse(`${name} is not a SWF.`, path);
    return;
  }

  current = { path, movie: { url: grants.grant(path), name } };
  settings.opened(path);
  app.addRecentDocument(path);
  buildMenu();
  if (window) {
    window.setTitle(`${name} — ${TITLE}`);
    if (listening) {
      window.webContents.send("desktop:open", current.movie);
    }
  }
}

function closeMovie(): void {
  current = null;
  buildMenu();
  window?.setTitle(TITLE);
  if (listening) {
    window?.webContents.send("desktop:close");
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

  settings.setLibrary(name, path);
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
        {
          label: "Open &Recent",
          submenu: [
            ...recent.map((path) => ({ label: path, click: () => void open(path) })),
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
          click: () => current && void open(current.path),
        },
        { role: "togglefullscreen", accelerator: "F11" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** The window's page may go nowhere but swf2es://app/, and open nothing but the system's browser. */
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
    }
  });
  if (trace) {
    contents.on("console-message", ({ level, message }) => {
      // A SWF's trace() is console.log's; warnings and errors are the page's own.
      (level === "info" ? process.stdout : process.stderr).write(`${message}\n`);
    });
  }
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
  bridgeSockets(trusted);
}

let pending = fileFromArguments(process.argv);
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
  settings = new SettingsFile(app.getPath("userData"));
  serve(session.defaultSession, grants, () => settings.libraries());
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
    void open(pending);
  }
});
