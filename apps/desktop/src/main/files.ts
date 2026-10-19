// A dialog grants an opaque capability, never a renderer-supplied path.
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  type BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  type WebContents,
} from "electron";

type Event = IpcMainEvent | IpcMainInvokeEvent;

export function bridgeFiles(
  trusted: (event: Event) => boolean,
  window: () => BrowserWindow | null,
  gesture: () => boolean,
): void {
  const grants = new Map<number, { path: string; write: boolean }>();
  let next = 1;
  let dialogOpen = false;
  const watched = new WeakSet<WebContents>();
  const watch = (owner: BrowserWindow) => {
    const contents = owner.webContents;
    if (watched.has(contents)) {
      return;
    }

    watched.add(contents);
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        grants.clear();
      }
    });
    contents.once("destroyed", () => grants.clear());
  };
  ipcMain.on("files:release", (event, id: unknown) => {
    if (trusted(event) && typeof id === "number") {
      grants.delete(id);
    }
  });
  const check = (event: Event, id: unknown, write: boolean): string => {
    const grant = typeof id === "number" ? grants.get(id) : undefined;
    if (!trusted(event) || !grant || grant.write !== write) {
      throw new Error("invalid file capability");
    }
    return grant.path;
  };
  ipcMain.handle("files:read", (event, id: unknown) => readFile(check(event, id, false)));
  ipcMain.handle("files:write", async (event, id: unknown, bytes: unknown) => {
    const path = check(event, id, true);
    if (!(bytes instanceof Uint8Array)) {
      throw new Error("invalid file bytes");
    }
    grants.delete(id as number);
    await writeFile(path, bytes);
  });
  ipcMain.handle("files:browse", async (event, filters: unknown, multiple: unknown) => {
    const owner = window();
    if (!trusted(event) || !owner || dialogOpen || !gesture()) {
      return [];
    }
    dialogOpen = true;
    try {
      const result = await dialog.showOpenDialog(owner, {
        properties: multiple === true ? ["openFile", "multiSelections"] : ["openFile"],
        filters: Array.isArray(filters)
          ? filters.slice(0, 100).flatMap((filter) => {
              if (
                typeof filter?.description !== "string" ||
                typeof filter?.extension !== "string"
              ) {
                return [];
              }
              const extensions = filter.extension
                .split(";")
                .map((ext: string) => ext.trim().replace(/^\*\./, ""))
                .filter((ext: string) => /^[\w-]+$/.test(ext));
              return extensions.length ? [{ name: filter.description, extensions }] : [];
            })
          : [],
      });
      if (result.canceled || !trusted(event)) {
        return [];
      }
      watch(owner);
      return await Promise.all(
        result.filePaths.map(async (path) => {
          const info = await stat(path);
          const id = next++;
          grants.set(id, { path, write: false });
          return {
            id,
            name: basename(path),
            size: info.size,
            modificationDate: info.mtimeMs,
            creationDate: info.birthtimeMs,
          };
        }),
      );
    } finally {
      dialogOpen = false;
    }
  });
  ipcMain.handle("files:save", async (event, name: unknown) => {
    const owner = window();
    if (!trusted(event) || !owner || typeof name !== "string" || dialogOpen || !gesture()) {
      return null;
    }
    dialogOpen = true;
    try {
      const result = await dialog.showSaveDialog(owner, { defaultPath: basename(name) });
      if (result.canceled || !result.filePath || !trusted(event)) {
        return null;
      }
      const id = next++;
      grants.set(id, { path: result.filePath, write: true });
      watch(owner);
      return { id, name: basename(result.filePath) };
    } finally {
      dialogOpen = false;
    }
  });
}
