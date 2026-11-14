// An AIR application's reach through the main process (shared/api.ts
// DesktopAir): its file system, its EncryptedLocalStore, its window and
// the screens. air.ts does the work apart from Electron.
import { readFile, realpath } from "node:fs/promises";
import {
  app,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  screen,
} from "electron";
import type { AirScreenState, AirWindowState } from "../shared/api.js";
import { createDirectoryOf, listOf, moveOf, readOf, removeOf, statOf, writeOf } from "./air.ts";
import { resolveCase } from "./case-paths.ts";
import { air, encryptedItems } from "./open.ts";
import { sandbox, trusted, window } from "./state.ts";

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

/** The displays as an AIR application's Screen reads them: the work area is past the system's bars. */
function screenStates(): AirScreenState[] {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display) => ({
    bounds: display.bounds,
    visibleBounds: display.workArea,
    colorDepth: display.colorDepth,
    main: display.id === primary,
  }));
}

/**
 * An AIR application's reach, shared/api.ts DesktopAir: the file system
 * and the window, only while one the user opened plays and only for its
 * page. The file system is read synchronously where File reads it so.
 */
export function listenForAir(): void {
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
      const real = await realpath(resolveCase(path));
      return sandbox.startApplication(real) ? new Uint8Array(await readFile(real)) : null;
    } catch {
      return null;
    }
  });
  ipcMain.on("air:window", (event) => {
    event.returnValue = playing(event) && window ? windowState(window) : null;
  });
  ipcMain.on("air:screens", (event) => {
    event.returnValue = playing(event) ? screenStates() : [];
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
