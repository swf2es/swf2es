// What AVM1's network classes ask of the host: XML's, LoadVars' and
// loadVariables' requests, through the host's fetch as AS3's URLLoader's
// go, and XMLSocket's connections, through the host's sockets as AS3's
// XMLSocket's go. What comes back is held for the next frame, where the
// movie delivers it between frames, as Flash's network callbacks come.
import type {
  FetchRequest,
  FetchResult,
  SocketEvents,
  SocketHost,
  SocketTransport,
} from "../hosts.js";

export type Fetch = (request: FetchRequest, signal: AbortSignal) => Promise<FetchResult>;

/** A request as a script asks it: its URL as given, resolved here against the SWF's. */
export interface NetRequest {
  url: string;
  method: "GET" | "POST";
  headers: [name: string, value: string][];
  body: Uint8Array | null;
}

const FAILED: FetchResult = { bytes: null, status: 0, headers: [] };

const encoder = new TextEncoder();

/**
 * Text from the network as a SWF of `version` holds it: up to SWF 5 a
 * string is bytes, a character each (the runtime's), here its UTF-8's.
 */
export function textFor(text: string, version: number): string {
  if (version > 5 || !/[^ -~\t\n\r]/.test(text)) {
    return text;
  }

  const bytes = encoder.encode(text);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x2000) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x2000)));
  }

  return parts.join("");
}

/** A string as the bytes it sends: up to SWF 5 its own bytes (UTF-8 past 0xFF), later its UTF-8. */
export function bytesFor(text: string, version: number): Uint8Array {
  if (version > 5) {
    return encoder.encode(text);
  }

  const bytes: number[] = [];
  for (const c of text) {
    const code = c.codePointAt(0) as number;
    if (code <= 0xff) {
      bytes.push(code);
    } else {
      bytes.push(...encoder.encode(c));
    }
  }

  return Uint8Array.from(bytes);
}

export class Avm1Net {
  /** Host callbacks held for the next frame, in the order they came. */
  private ready: (() => void)[] = [];
  private readonly pending = new Set<Promise<void>>();
  private readonly stopped = new AbortController();
  /** The connections open, for destroy to close. */
  private readonly connections = new Set<SocketTransport>();
  private destroyed = false;

  constructor(
    private readonly fetchHost: Fetch | null,
    private readonly socketHost: SocketHost | null,
    /** Where relative URLs resolve: the page's base where it gives one, else the SWF's URL. */
    private readonly base: string,
  ) {}

  /** `url` as the request goes out: against the base, as a load's URL resolves in AS3. */
  resolve(url: string): string {
    try {
      return new URL(url, this.base).href;
    } catch {
      return url;
    }
  }

  /**
   * `request` sent by the host's fetch, as "data", which the host judges
   * as it judges a URLLoader's; `deliver` gets the result in a frame
   * after, a failure as no bytes, status 0, where nothing answered.
   */
  fetch(request: NetRequest, deliver: (result: FetchResult) => void): void {
    const fetch = this.fetchHost;
    const outgoing: FetchRequest = { ...request, url: this.resolve(request.url), purpose: "data" };
    const fetched = (fetch ? fetch(outgoing, this.stopped.signal) : Promise.reject()).then(
      (result) => result,
      () => FAILED,
    );
    this.track(fetched.then((result) => this.defer(() => deliver(result))));
  }

  /** `request` sent and its answer dropped, as a send without a window is. */
  send(request: NetRequest): void {
    this.fetchHost?.(
      { ...request, url: this.resolve(request.url), purpose: "send" },
      this.stopped.signal,
    ).catch(() => {});
  }

  /**
   * A connection to `host` and `port` through the host's sockets, its
   * events held for the next frame; null where there are none, or the host
   * refused at once, which `refused` is then called for in a frame after.
   */
  connect(
    host: string,
    port: number,
    events: SocketEvents,
    refused: () => void,
  ): SocketTransport | null {
    const sockets = this.socketHost;
    if (sockets === null || this.destroyed) {
      this.defer(refused);
      return null;
    }

    let transport: SocketTransport | null = null;
    const forget = () => {
      if (transport !== null) {
        this.connections.delete(transport);
      }
    };
    try {
      transport = sockets.connect(host, port, {
        open: (endpoints) => this.defer(() => events.open(endpoints)),
        data: (bytes) => {
          const copy = bytes.slice();
          this.defer(() => events.data(copy));
        },
        close: () => {
          forget();
          this.defer(() => events.close());
        },
        error: (message) => {
          forget();
          this.defer(() => events.error(message));
        },
      });
    } catch {
      this.defer(refused);
      return null;
    }

    this.connections.add(transport);
    return transport;
  }

  /** A connection the script closed: destroy need not close it. */
  closed(transport: SocketTransport): void {
    this.connections.delete(transport);
    transport.close();
  }

  /** The callbacks the host has made since the last call, to deliver now. */
  take(): (() => void)[] {
    const ready = this.ready;
    this.ready = [];
    return ready;
  }

  /** Resolves once every request so far has come back, and is held for the next frame. */
  settled(): Promise<void> {
    return Promise.all([...this.pending]).then(() => {});
  }

  /** The player gone: the fetches under way are aborted and the connections closed. */
  destroy(): void {
    this.destroyed = true;
    this.ready = [];
    this.stopped.abort();
    for (const transport of [...this.connections]) {
      this.connections.delete(transport);
      transport.close();
    }
  }

  private defer(event: () => void): void {
    if (!this.destroyed) {
      this.ready.push(event);
    }
  }

  private track(task: Promise<void>): void {
    this.pending.add(task);
    void task.then(() => this.pending.delete(task));
  }
}
