// air.net.WebSocket over the shell's connections: what the player asks of
// a WebSocketHost, carried to the main process and back. The page's own
// WebSocket reaches nothing: the page has no network.
import type { WebSocketEvents, WebSocketHost } from "@swf2es/player";
import type { DesktopWebSockets } from "../shared/api.js";

export function shellWebSocketHost(webSockets: DesktopWebSockets): WebSocketHost {
  // Until its close, which the shell sends after a failure too.
  const open = new Map<number, WebSocketEvents>();
  // A batch is one task: its events, a message each, go to their connections in one loop.
  webSockets.onEvents((batch) => {
    for (let i = 0; i < batch.length; i++) {
      const [id, event] = batch[i];
      const events = open.get(id);
      if (!events) {
        continue;
      }

      // One that throws leaves the rest to run, as when each came in a message of its own.
      try {
        switch (event.type) {
          case "open":
            events.open(event.protocol);
            break;
          case "message":
            events.message(event.data);
            break;
          case "error":
            events.error();
            break;
          case "close":
            open.delete(id);
            events.close(event.code);
            break;
        }
      } catch (error) {
        reportError(error);
      }
    }
  });

  return {
    connect(url, protocols, events) {
      const id = webSockets.connect(url, protocols);
      open.set(id, events);
      return {
        send: (data) => webSockets.send(id, data),
        close: (code) => webSockets.close(id, code),
      };
    },
  };
}
