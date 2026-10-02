// A binary WebSocket bridge for flash.net.Socket. The caller chooses its URL protocol.
import type { SocketHost } from "@swf2es/player";

/** Map the AS3 host and port to a WebSocket endpoint that relays a byte stream. */
export function webSocketSocketHost(
  urlFor: (host: string, port: number) => string,
  open: (url: string) => WebSocket = (url) => new WebSocket(url),
): SocketHost {
  return {
    connect(host, port, events) {
      const socket = open(urlFor(host, port));
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => events.open());
      socket.addEventListener("message", ({ data }) => {
        if (data instanceof ArrayBuffer) {
          events.data(new Uint8Array(data));
        } else {
          events.error("Socket bridge sent a non-binary WebSocket message.");
          socket.close();
        }
      });
      socket.addEventListener("close", () => events.close());
      socket.addEventListener("error", () => events.error("Error #2031: Socket Error."));

      return {
        // Browser WebSocket accepts typed arrays; the Socket native supplies ArrayBuffer-backed bytes.
        send: (bytes) => socket.send(bytes as Uint8Array<ArrayBuffer>),
        close: () => socket.close(),
      };
    },
  };
}
