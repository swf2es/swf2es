// flash.net.Socket over the shell's TCP connections: what the player asks
// of a SocketHost, carried to the main process and back.
import type { SocketEvents, SocketHost } from "@swf2es/player";
import type { DesktopSockets } from "../shared/api.js";

export function shellSocketHost(sockets: DesktopSockets): SocketHost {
  // Until its close, which the shell sends after an error and after a close asked for.
  const open = new Map<number, SocketEvents>();
  // A turn's events at once, each to its connection in turn.
  sockets.onEvents((batch) => {
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
            events.open(event);
            break;
          case "data":
            events.data(event.bytes);
            break;
          case "error":
            events.error(event.message);
            break;
          case "close":
            open.delete(id);
            events.close();
            break;
        }
      } catch (error) {
        reportError(error);
      }
    }
  });

  return {
    connect(host, port, events) {
      const id = sockets.connect(host, port);
      open.set(id, events);
      return {
        send: (bytes) => sockets.send(id, bytes),
        close: () => sockets.close(id),
      };
    },
  };
}
