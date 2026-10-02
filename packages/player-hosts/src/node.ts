// Node's TCP transport for flash.net.Socket; imported only by hosts that opt in.
import { connect } from "node:net";
import type { SocketHost } from "@swf2es/player";

/** A host that connects ActionScript sockets to TCP directly from Node. */
export function nodeSocketHost(): SocketHost {
  return {
    connect(host, port, events) {
      const socket = connect({ host, port });
      socket.on("connect", () => events.open());
      socket.on("data", (bytes) => events.data(bytes));
      socket.on("close", () => events.close());
      socket.on("error", () => events.error("Error #2031: Socket Error."));

      return {
        // Socket.flush has already combined its pending bytes into one chunk.
        send: (bytes) => socket.write(bytes),
        close: () => socket.destroy(),
      };
    },
  };
}
