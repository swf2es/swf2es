// What websocket-connections.ts uses of ws, which has no types of its own;
// @types/ws would be a dependency for this alone.
declare module "ws" {
  import { EventEmitter } from "node:events";
  import type { IncomingMessage } from "node:http";
  import type { Duplex } from "node:stream";

  interface ClientOptions {
    /** Makes the connection the handshake goes over; it may answer through `done` later. */
    createConnection?: (
      options: object,
      done: (error: Error | null, socket?: Duplex) => void,
    ) => Duplex | undefined;
    headers?: Record<string, string>;
    perMessageDeflate?: boolean;
    autoPong?: boolean;
    skipUTF8Validation?: boolean;
    followRedirects?: boolean;
    handshakeTimeout?: number;
    maxPayload?: number;
  }

  class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;
    constructor(address: string, options?: ClientOptions);
    readonly readyState: 0 | 1 | 2 | 3;
    readonly bufferedAmount: number;
    send(data: Uint8Array, options: { binary: boolean }): void;
    ping(data: Uint8Array): void;
    pong(data: Uint8Array): void;
    close(code?: number, reason?: Uint8Array): void;
    terminate(): void;
    on(event: "open", listener: () => void): this;
    on(event: "upgrade", listener: (response: IncomingMessage) => void): this;
    on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
    on(event: "ping" | "pong", listener: (data: Buffer) => void): this;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  }

  export default WebSocket;
}
