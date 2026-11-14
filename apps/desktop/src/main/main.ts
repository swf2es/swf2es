// The desktop app's main process: one window on swf2es://app/, the menu,
// the files the user opens, the libraries they point at, and the page's
// few requests (shared/api.ts), each checked to come from that page.
//
//   electron apps/desktop [--trace] [file.swf | http(s)://host/movie.swf]
//   electron apps/desktop [--trace] app.xml [root-dir] [-- arguments...]
//
// --ignore-certificate-errors[=host,...] leaves HTTPS and WSS certificates unchecked.
// --proxy=socks5://[user:pass@]host:port (or http://...) sends the SWF's network through a proxy.
//
// The second runs an AIR application by its descriptor, as adl does.
//
// Its parts: state.ts, what they share; switches.ts, the command line's;
// open.ts, what plays and opening it; permissions.ts, sockets and
// WebSockets; dialogs.ts and menu.ts; air-bridge.ts, an AIR application's
// reach. Here: start-up, the window and its page's messages.
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, session, shell, type WebContents } from "electron";
import type { NetworkResponse, StartState } from "../shared/api.js";
import { airCommand } from "./air.ts";
import { listenForAir } from "./air-bridge.ts";
import { chooseLibrary, fromPrompt, prompt, showOpenDialog, showUrlDialog } from "./dialogs.ts";
import { bridgeFiles } from "./files.ts";
import { buildMenu } from "./menu.ts";
import { failureLine, requestLine } from "./netlog.ts";
import { Refused } from "./network-types.ts";
import {
  current,
  movieFromArguments,
  networkMovie,
  openAir,
  openChosen,
  openEntry,
  openUrl,
  remoteUrl,
} from "./open.ts";
import { permitSocket, permitWebSocket } from "./permissions.ts";
import { APP_ORIGIN, registerScheme, serve } from "./protocol.ts";
import { proxyArgument, sameProxy } from "./proxy.ts";
import { SettingsFile } from "./settings.ts";
import { bridgeSockets } from "./sockets.ts";
import {
  sandbox,
  setListening,
  setSettings,
  settings,
  setWindow,
  TITLE,
  trusted,
  window,
} from "./state.ts";
import {
  logSockets,
  netLog,
  network,
  proxied,
  proxy,
  trace,
  via,
  warn,
  webSocketOpen,
} from "./switches.ts";
import { bridgeWebSockets } from "./websockets.ts";

const preload = fileURLToPath(new URL("../preload/preload.cjs", import.meta.url));
// The window's and the taskbar's icon, the project's, where the platform takes one from the window.
const icon = fileURLToPath(new URL("../../static/icon.png", import.meta.url));

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

/** What the page's requests under way abort with, by the preload's number. */
const requests = new Map<number, AbortController>();

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
      setListening(false);
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

function createWindow(): void {
  const window = new BrowserWindow({
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
  setWindow(window);
  // The title is the movie's, set here, not the page's <title>.
  window.on("page-title-updated", (event) => event.preventDefault());
  window.on("closed", () => {
    setWindow(null);
  });
  // The page hears of full screen however it came, a SWF's Stage.displayState or the menu's F11.
  window.on("enter-full-screen", () => window?.webContents.send("desktop:full-screen", true));
  window.on("leave-full-screen", () => window?.webContents.send("desktop:full-screen", false));
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

    setListening(true);
    return {
      stage3D: settings.stage3D,
      libraries: settings.libraries(),
      movie: current?.movie ?? null,
      build,
    };
  });
  // Stage.displayState of a SWF the user opened: the window's full screen, asked with no gesture.
  ipcMain.on("desktop:full-screen", (event, fullScreen: unknown) => {
    if (trusted(event) && current && window) {
      window.setFullScreen(fullScreen === true);
    }
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
  bridgeSockets(trusted, permitSocket, netLog, logSockets, { proxy, warn });
  bridgeWebSockets(trusted, permitWebSocket, webSocketOpen, netLog, logSockets, via);
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
      ) + via,
    );
    return response;
  } catch (error) {
    // A refusal says why; anything else, which should not happen, is said too.
    if (!controller.signal.aborted) {
      const why = error instanceof Refused ? error.message : `failed: ${error}`;
      process.stderr.write(`swf2es: not loading ${shown}: ${why}\n`);
    } else {
      netLog?.(failureLine(method, url, "aborted", performance.now() - started) + via);
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
  if (proxied) {
    process.stderr.write(
      "swf2es: handed to the app already open, which opens it only if started with the same --proxy\n",
    );
  }

  app.quit();
}

app.on("second-instance", (_event, argv, workingDirectory) => {
  // What it names would go through another proxy than this app's, or past it.
  const asked = proxyArgument(argv.slice(1));
  if (asked && !("proxy" in asked && sameProxy(asked.proxy, proxy))) {
    process.stderr.write(
      "swf2es: not opening what a second start named: its --proxy is not this app's\n",
    );
    return;
  }

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

  setSettings(new SettingsFile(app.getPath("userData")));
  // A playerglobal chosen once is kept across versions of the app: said at each start, as a
  // library older or newer than the app's own makes SWFs fail in ways nothing else explains.
  const chosen = settings.libraries().playerglobal;
  if (chosen) {
    process.stderr.write(
      `swf2es: playing on the playerglobal chosen in File, ${chosen}, not the app's own\n`,
    );
  }

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
