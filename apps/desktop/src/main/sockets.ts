// flash.net.Socket's TCP connections, made here with node:net for the
// page, which has no network of its own beyond fetch. Each connection
// belongs to the page that asked for it and closes as that page goes.
import { connect, type Socket } from "node:net";
import { type IpcMainEvent, ipcMain, type WebContents } from "electron";
import type { SocketEvent } from "../shared/api.js";

/** As many as a page may hold open at once; past it a connection is refused. */
const MAX_OPEN = 64;

/**
 * Carry socket messages from pages that `trusted` accepts. A page's
 * connections close as it navigates, reloads or goes.
 */
export function bridgeSockets(trusted: (event: IpcMainEvent) => boolean): void {
  const pages = new Map<WebContents, Map<number, Socket>>();

  const socketsOf = (contents: WebContents): Map<number, Socket> => {
    let sockets = pages.get(contents);
    if (!sockets) {
      sockets = new Map();
      pages.set(contents, sockets);
      const closeAll = () => {
        // Silently: the next page numbers its sockets from 1 again, and must not hear these.
        for (const socket of sockets?.values() ?? []) {
          socket.removeAllListeners();
          socket.on("error", () => {});
          socket.destroy();
        }

        sockets?.clear();
      };
      contents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) {
          closeAll();
        }
      });
      contents.once("destroyed", () => {
        closeAll();
        pages.delete(contents);
      });
    }

    return sockets;
  };

  const tell = (contents: WebContents, id: number, event: SocketEvent) => {
    if (!contents.isDestroyed()) {
      contents.send("socket:event", id, event);
    }
  };

  ipcMain.on("socket:connect", (event, id: unknown, host: unknown, port: unknown) => {
    if (!trusted(event) || typeof id !== "number") {
      return;
    }

    const contents = event.sender;
    const sockets = socketsOf(contents);
    const valid =
      typeof host === "string" &&
      host.length > 0 &&
      host.length <= 255 &&
      Number.isInteger(port) &&
      (port as number) > 0 &&
      (port as number) < 65536;
    if (!valid || sockets.has(id) || sockets.size >= MAX_OPEN) {
      tell(contents, id, { type: "error", message: "Error #2031: Socket Error." });
      tell(contents, id, { type: "close" });
      return;
    }

    const socket = connect({ host, port: port as number });
    sockets.set(id, socket);
    socket.on("connect", () =>
      tell(contents, id, {
        type: "open",
        localAddress: socket.localAddress ?? "",
        localPort: socket.localPort ?? 0,
        remoteAddress: socket.remoteAddress ?? "",
        remotePort: socket.remotePort ?? 0,
      }),
    );
    socket.on("data", (bytes) =>
      tell(contents, id, { type: "data", bytes: new Uint8Array(bytes) }),
    );
    socket.on("error", () =>
      tell(contents, id, { type: "error", message: "Error #2031: Socket Error." }),
    );
    socket.on("close", () => {
      // Only the socket under this id: a page that reused it has another by now.
      if (sockets.get(id) === socket) {
        sockets.delete(id);
      }

      tell(contents, id, { type: "close" });
    });
  });

  ipcMain.on("socket:send", (event, id: unknown, bytes: unknown) => {
    if (trusted(event) && bytes instanceof Uint8Array) {
      pages
        .get(event.sender)
        ?.get(id as number)
        ?.write(bytes);
    }
  });

  ipcMain.on("socket:close", (event, id: unknown) => {
    if (trusted(event)) {
      pages
        .get(event.sender)
        ?.get(id as number)
        ?.destroy();
    }
  });
}
