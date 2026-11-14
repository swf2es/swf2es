// The app's dialogs: an error, File › Open, the library chooser, and the
// URL dialog, a window of its own.
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, dialog, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import type { LibraryName } from "../shared/api.js";
import { buildMenu } from "./menu.ts";
import { openChosen, readStart } from "./open.ts";
import { APP_ORIGIN } from "./protocol.ts";
import { settings, window } from "./state.ts";

const promptPreload = fileURLToPath(new URL("../preload/prompt.cjs", import.meta.url));
const PROMPT_URL = `${APP_ORIGIN}/open-url.html`;

/** The dialog that asks for a URL, while it is open. */
export let prompt: BrowserWindow | null = null;

export function refuse(message: string, detail: string): void {
  if (window) {
    void dialog.showMessageBox(window, { type: "error", message, detail });
  }
}

export async function showOpenDialog(): Promise<void> {
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
export async function chooseLibrary(name: LibraryName): Promise<void> {
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

  buildMenu();

  // The page fetched the libraries once; a fresh page fetches the new one.
  window.webContents.reload();
}

/** Play on the library the app ships again, in place of one the user chose. */
export function resetLibrary(name: LibraryName): void {
  if (!settings.clearLibrary(name)) {
    refuse("The settings could not be saved.", `swf2es uses its own ${name} until it quits.`);
  }

  buildMenu();
  window?.webContents.reload();
}

/**
 * The dialog that asks for a SWF's URL: a window of its own, apart from the
 * page, so that only the user, and never a SWF, opens one by its URL.
 */
export function showUrlDialog(): void {
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
export function fromPrompt(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return (
    prompt !== null &&
    event.sender === prompt.webContents &&
    frame !== null &&
    frame.parent === null &&
    frame.url === PROMPT_URL
  );
}
