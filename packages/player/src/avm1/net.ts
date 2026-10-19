// What AVM1's network classes ask of the host: XML's, LoadVars' and
// loadVariables' requests, through the host's fetch as AS3's URLLoader's
// go, loadMovie's as AS3's Loader's go, and XMLSocket's connections,
// through the host's sockets as AS3's XMLSocket's go. What comes back is
// held for the next frame, where the movie delivers it between frames, as
// Flash's network callbacks come.
import type {
  FetchPurpose,
  FetchRequest,
  FetchResult,
  SocketEvents,
  SocketHost,
  SocketTransport,
} from "../hosts.js";
import { resolve } from "../scripting/loads.js";

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
    /** Whether a send without a window goes, as allowNetworking "internal" or "none" has it not. */
    private readonly sends = true,
  ) {}

  /** `url` as the request goes out: against the base, as a load's URL resolves in AS3. */
  resolve(url: string): string {
    return resolve(this.base, url);
  }

  /**
   * `request` sent by the host's fetch, as "data", which the host judges
   * as it judges a URLLoader's; `deliver` gets the result in a frame
   * after, a failure as no bytes, status 0, where nothing answered.
   */
  fetch(request: NetRequest, deliver: (result: FetchResult) => void): void {
    this.after(this.request(request, "data"), deliver);
  }

  /**
   * `request` sent by the host's fetch, as `purpose`: its result, a
   * failure as no bytes, status 0, where nothing answered. A movie's load
   * is "content", as AS3's Loader's is.
   */
  request(request: NetRequest, purpose: FetchPurpose, signal?: AbortSignal): Promise<FetchResult> {
    const fetch = this.fetchHost;
    if (this.destroyed) {
      return Promise.resolve(FAILED);
    }

    const outgoing: FetchRequest = { ...request, url: this.resolve(request.url), purpose };
    return (
      fetch
        ? fetch(
            outgoing,
            signal ? AbortSignal.any([signal, this.stopped.signal]) : this.stopped.signal,
          )
        : Promise.reject()
    ).then(
      (result) => result,
      () => FAILED,
    );
  }

  /**
   * `task`'s value delivered to `deliver` in a frame after it settles;
   * nothing for one that fails.
   */
  after<T>(task: Promise<T>, deliver: (value: T) => void): void {
    this.track(
      task.then(
        (value) => this.defer(() => deliver(value)),
        () => {},
      ),
    );
  }

  /**
   * `request` sent and its answer dropped, as a send without a window is,
   * as AS3's sendToURL is: whether it went, which allowNetworking
   * "internal" refuses as it refuses sendToURL.
   */
  send(request: NetRequest): boolean {
    if (!this.sends || this.destroyed) {
      return false;
    }

    this.fetchHost?.(
      { ...request, url: this.resolve(request.url), purpose: "send" },
      this.stopped.signal,
    ).catch(() => {});
    return true;
  }

  /**
   * A connection to `host` and `port` through the host's sockets, its
   * events held for the next frame; null where there are none, or the host
   * refused at once, which `refused` is then called for in a frame after.
   * One that has not opened `timeout` ms on (none for 0) is closed, and
   * fails as a refused one does, as XMLSocket.timeout has it.
   */
  connect(
    host: string,
    port: number,
    events: SocketEvents,
    refused: () => void,
    timeout = 0,
  ): SocketTransport | null {
    const sockets = this.socketHost;
    if (sockets === null || this.destroyed) {
      this.defer(refused);
      return null;
    }

    let transport: SocketTransport | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let opened = false;
    let ended = false;
    const stopTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    // Closed or failed, by either end or the timeout: forgotten, and the timeout has nothing to do.
    const end = () => {
      ended = true;
      stopTimer();
      if (transport !== null) {
        this.connections.delete(transport);
      }
    };
    try {
      transport = sockets.connect(host, port, {
        open: (endpoints) => {
          opened = true;
          stopTimer();
          this.defer(() => events.open(endpoints));
        },
        data: (bytes) => {
          const copy = bytes.slice();
          this.defer(() => events.data(copy));
        },
        close: () => {
          end();
          this.defer(() => events.close());
        },
        error: (message) => {
          end();
          this.defer(() => events.error(message));
        },
      });
    } catch {
      this.defer(refused);
      return null;
    }

    if (ended) {
      return transport;
    }

    this.connections.add(transport);
    if (!opened && timeout > 0) {
      const opening = transport;
      timer = setTimeout(() => {
        timer = null;
        // Closed by the script, or the player gone, meanwhile: nothing to time out.
        if (opened || ended || !this.connections.has(opening)) {
          return;
        }

        end();
        opening.close();
        this.defer(() => events.error("timeout"));
      }, timeout);
    }

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

  /**
   * The player gone, or its SWF stopped for good: the fetches under way are
   * aborted, the connections closed, and nothing more is held.
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }

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
