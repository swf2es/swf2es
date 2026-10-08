// flash.net.Socket's TCP connections, made here for the page, which has
// no network of its own beyond fetch, and carried over IPC. Each page's
// connections (connections.ts) close as it navigates, reloads or goes.
import { type IpcMainEvent, ipcMain, type WebContents } from "electron";
import { Connections, validEndpoint } from "./connections.ts";

/**
 * Carry socket messages from pages that `trusted` accepts, each connection
 * made only as `permit` allows it, to the address it gives where it gives
 * one; null refuses it.
 */
export function bridgeSockets(
  trusted: (event: IpcMainEvent) => boolean,
  permit: (host: string, port: number) => Promise<{ address?: string } | null>,
): void {
  const pages = new Map<WebContents, Connections>();

  const connectionsOf = (contents: WebContents): Connections => {
    const known = pages.get(contents);
    if (known) {
      return known;
    }

    const connections = new Connections((id, event) => {
      if (!contents.isDestroyed()) {
        contents.send("socket:event", id, event);
      }
    });
    pages.set(contents, connections);
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        connections.closeAll();
      }
    });
    contents.once("destroyed", () => {
      connections.closeAll();
      pages.delete(contents);
    });
    return connections;
  };

  ipcMain.on("socket:connect", (event, id: unknown, host: unknown, port: unknown) => {
    if (!trusted(event) || typeof id !== "number") {
      return;
    }

    const connections = connectionsOf(event.sender);
    if (!validEndpoint(host, port)) {
      connections.refuse(id);
      return;
    }

    const generation = connections.generation;
    void permit(host, port as number)
      .catch(() => null)
      .then((allowed) => {
        // The page that asked may have gone while the user was asked.
        if (connections.generation !== generation) {
          return;
        }

        if (allowed) {
          connections.connect(id, host, port, allowed.address);
        } else {
          connections.refuse(id);
        }
      });
  });

  ipcMain.on("socket:send", (event, id: unknown, bytes: unknown) => {
    if (trusted(event) && typeof id === "number" && bytes instanceof Uint8Array) {
      pages.get(event.sender)?.send(id, bytes);
    }
  });

  ipcMain.on("socket:close", (event, id: unknown) => {
    if (trusted(event) && typeof id === "number") {
      pages.get(event.sender)?.close(id);
    }
  });
}
