// air.net.WebSocket's connections, made here for the page, which has no
// network of its own, and carried over IPC as flash.net.Socket's are
// (sockets.ts). Each page's connections (websocket-connections.ts) close
// as it navigates, reloads or goes.
import { type IpcMainEvent, ipcMain, type WebContents } from "electron";
import { webSocketDataLine, webSocketLine } from "./netlog.ts";
import {
  type Opener,
  validProtocols,
  validWebSocketUrl,
  WebSocketConnections,
} from "./websocket-connections.ts";

/**
 * Carry WebSocket messages from pages that `trusted` accepts, each
 * connection made only where `permit` allows its URL, with `open` if
 * given. `log`, where given, is told each connection asked for, opened,
 * refused, failed and closed (--log-network), and with `data` what each
 * sends and receives too (--log-sockets), the connections' lines ending
 * in `via`.
 */
export function bridgeWebSockets(
  trusted: (event: IpcMainEvent) => boolean,
  permit: (url: string) => boolean,
  open: Opener | undefined,
  log: ((line: string) => void) | null = null,
  data = false,
  via = "",
): void {
  const pages = new Map<WebContents, WebSocketConnections>();

  const connectionsOf = (contents: WebContents): WebSocketConnections => {
    const known = pages.get(contents);
    if (known) {
      return known;
    }

    const connections = new WebSocketConnections((id, event) => {
      if (log) {
        switch (event.type) {
          case "open":
            log(webSocketLine(id, event.protocol === "" ? "open" : `open ${event.protocol}`));
            break;
          case "message":
            if (data) {
              log(webSocketDataLine(id, false, event.data));
            }

            break;
          case "close":
            log(webSocketLine(id, `close ${event.code}`));
            break;
          case "error":
            log(webSocketLine(id, "error"));
            break;
        }
      }

      if (!contents.isDestroyed()) {
        contents.send("websocket:event", id, event);
      }
    }, open);
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

  ipcMain.on("websocket:connect", (event, id: unknown, url: unknown, protocols: unknown) => {
    if (!trusted(event) || typeof id !== "number") {
      return;
    }

    const connections = connectionsOf(event.sender);
    if (!validWebSocketUrl(url) || !validProtocols(protocols)) {
      connections.refuse(id);
      return;
    }

    // As the client will read it: what is said of it has nothing a terminal would act on.
    const href = new URL(url).href;
    const allowed = permit(href);
    log?.(webSocketLine(id, `${allowed ? `connecting to ${href}${via}` : `refused ${href}`}`));
    if (allowed) {
      connections.connect(id, href, protocols);
    } else {
      connections.refuse(id);
    }
  });

  ipcMain.on("websocket:send", (event, id: unknown, message: unknown) => {
    if (
      trusted(event) &&
      typeof id === "number" &&
      (typeof message === "string" || message instanceof Uint8Array)
    ) {
      if (log && data) {
        log(webSocketDataLine(id, true, message));
      }

      pages.get(event.sender)?.send(id, message);
    }
  });

  ipcMain.on("websocket:close", (event, id: unknown, code: unknown) => {
    if (trusted(event) && typeof id === "number") {
      pages.get(event.sender)?.close(id, code);
    }
  });
}
