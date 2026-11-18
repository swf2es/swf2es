// Node's TCP and TLS transports for Socket and SecureSocket, and threads for
// flash.system.Worker; imported only by hosts that opt in.
import { connect } from "node:net";
import { Worker } from "node:worker_threads";
import type { SocketHost, WorkerHost } from "@swf2es/player";
import type { ThreadStart } from "@swf2es/player/worker";
import { tlsSocket, validCertificate } from "./tls.js";

export { type TlsTransport, tlsSocket, validCertificate } from "./tls.js";

/** A host that connects ActionScript sockets to TCP or TLS directly from Node. */
export function nodeSocketHost(): SocketHost {
  return {
    secure: {
      isCertificate: validCertificate,
      connect(host, port, events, options) {
        const raw = connect({ host, port, noDelay: options.noDelay ?? true });
        return tlsSocket(raw, host, events, options);
      },
    },
    connect(host, port, events, options) {
      // At once unless the SWF set tcpNoDelay to false, as the desktop's sockets.
      const socket = connect({ host, port, noDelay: options?.noDelay ?? true });
      socket.on("connect", () =>
        events.open({
          localAddress: socket.localAddress ?? "",
          localPort: socket.localPort ?? 0,
          remoteAddress: socket.remoteAddress ?? "",
          remotePort: socket.remotePort ?? 0,
        }),
      );
      // Each chunk a buffer of its own, never written again.
      socket.on("data", (bytes) => events.data(bytes, true));
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

/** Background workers on worker_threads Workers running node-worker.js, given codegen compiled. */
export function nodeWorkerHost(options: { codegen: WebAssembly.Module }): WorkerHost {
  return {
    start(init, receive, failed) {
      const worker = new Worker(new URL("./node-worker.js", import.meta.url));
      worker.on("message", receive);
      worker.on("error", failed);
      const start: ThreadStart = { codegen: options.codegen, init };
      worker.postMessage(start);
      return {
        post: (message) => worker.postMessage(message),
        terminate: () => worker.terminate(),
      };
    },
  };
}
