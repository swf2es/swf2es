// air.net.WebSocket's connections, made here for the page, which has no
// network of its own, and carried over IPC as flash.net.Socket's are
// (sockets.ts), each frame the page sends as AIR sends it. Each page's
// connections (websocket-connections.ts) close as it navigates, reloads or
// goes, or its process does (page-end.ts), and their events go to it
// gathered, a message a millisecond at most (relay.ts), each message an
// event of its own.
import { type IpcMainEvent, ipcMain, type WebContents } from "electron";
import type { WebSocketEvent } from "../shared/api.js";
import { webSocketDataLine, webSocketLine } from "./netlog.ts";
import { onPageEnd } from "./page-end.ts";
import { Relay } from "./relay.ts";
import {
  validOpcode,
  validProtocols,
  validWebSocketUrl,
  WebSocketConnections,
  type WebSocketOptions,
} from "./websocket-connections.ts";

/** A connection's id, as the preload numbers them. */
const validId = (id: unknown): id is number => Number.isInteger(id);

/**
 * Carry WebSocket frames from pages that `trusted` accepts, each
 * connection made only where `permit` allows its URL, as `options` say
 * (the proxy, the certificates). `log`, where given, is told each
 * connection asked for, opened, refused, failed and closed
 * (--log-network), and with `data` each frame sent and message received
 * too (--log-sockets), the connections' lines ending in `via`.
 */
export function bridgeWebSockets(
  trusted: (event: IpcMainEvent) => boolean,
  permit: (url: string) => boolean,
  options: WebSocketOptions,
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

    const relay = new Relay<WebSocketEvent>((batch) => {
      // Never to a page whose process is gone, which its frame shows before render-process-gone
      // comes: Electron would say so for each batch.
      if (!contents.isDestroyed() && !contents.isCrashed()) {
        contents.send("websocket:events", batch);
      }
    });
    const connections = new WebSocketConnections((id, event) => {
      if (log) {
        switch (event.type) {
          case "open":
            log(webSocketLine(id, event.protocol === "" ? "open" : `open ${event.protocol}`));
            break;
          case "message":
            if (data) {
              log(webSocketDataLine(id, false, event.text ? 1 : 2, event.data));
            }

            break;
          case "close":
            log(webSocketLine(id, `close ${event.code}`));
            break;
          case "error":
            log(webSocketLine(id, event.failure ? `error: ${event.failure}` : "error"));
            break;
          case "certificate":
            log(webSocketLine(id, "self-signed certificate, the application asked"));
            break;
        }
      }

      relay.push(id, event, event.type === "message" ? event.data.length : 0);
    }, options);
    pages.set(contents, connections);
    // A crashed page's too: its server would otherwise keep talking to no one, for hours.
    onPageEnd(contents, (how) => {
      connections.closeAll();
      relay.drop();
      if (how === "destroyed") {
        pages.delete(contents);
      }
    });
    return connections;
  };

  ipcMain.on("websocket:connect", (event, id: unknown, url: unknown, protocols: unknown) => {
    if (!trusted(event) || !validId(id)) {
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

  ipcMain.on("websocket:frame", (event, id: unknown, opcode: unknown, payload: unknown) => {
    if (trusted(event) && validId(id) && validOpcode(opcode) && payload instanceof Uint8Array) {
      if (log && data) {
        log(webSocketDataLine(id, true, opcode, payload));
      }

      pages.get(event.sender)?.frame(id, opcode, payload);
    }
  });

  ipcMain.on("websocket:certificate", (event, id: unknown, accepted: unknown) => {
    if (trusted(event) && validId(id) && typeof accepted === "boolean") {
      log?.(webSocketLine(id, accepted ? "certificate accepted" : "certificate refused"));
      pages.get(event.sender)?.certificate(id, accepted);
    }
  });
}
