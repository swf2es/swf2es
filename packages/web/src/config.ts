// What every player on a page shares, set once: where the compiler and
// the libraries come from, how sockets reach their servers, whether
// compiled code is cached. Each is fetched once a page, on first use.
import { type Codegen, createCodegen } from "@swf2es/codegen";
import {
  type FetchRequest,
  type FetchResult,
  type FileHost,
  type ModuleCache,
  playerglobalLibrary,
  type SocketHost,
} from "@swf2es/player";
import { indexedDbModuleCache } from "@swf2es/player-hosts/indexeddb";
import { webSocketSocketHost } from "@swf2es/player-hosts/websocket";
import type { WebWorkerHost } from "@swf2es/player-hosts/workers";
import type { Stage3DSurfaceFactory } from "./stage3d.js";

/** A flash.net.Socket's host and port, and the WebSocket relay that reaches it, as Ruffle's socketProxy lists them. */
export interface SocketProxy {
  host: string;
  port: number;
  proxyUrl: string;
}

export interface Configuration {
  /**
   * The ABCs a SWF's ActionScript 3 links against, by URL: avmplus'
   * builtin.abc, and a playerglobal in place of the one swf2es ships
   * (playerglobalLibrary), if one is given. Without builtin only SWFs with
   * no ActionScript 3 play.
   */
  libraries?: { builtin: string; playerglobal?: string };
  /** codegen.wasm's URL: by default what the page's import map gives `@swf2es/codegen/codegen.wasm`. */
  codegen?: string;
  /**
   * Where flash.net.Socket connects: a function from the host and port it
   * asks for to a WebSocket relay's URL, null for none, or a list. A
   * socket with no relay fails as one refused (IOErrorEvent #2031).
   */
  socketProxy?: ((host: string, port: number) => string | null) | SocketProxy[];
  /**
   * A host of the embedder's own for flash.net.Socket, in place of
   * socketProxy's relays: a desktop app's, which reaches TCP itself.
   */
  sockets?: SocketHost;
  fileHost?: FileHost | null;
  /**
   * A fetch of the embedder's own for what the SWFs load, the SWF the
   * element plays among it (its purpose "movie"), in place of the
   * browser's: a desktop app's, which judges each request by Flash's
   * sandboxes and policy files rather than CORS.
   */
  fetch?: (request: FetchRequest, signal: AbortSignal) => Promise<FetchResult>;
  /** Takes the policy files a SWF names with Security.loadPolicyFile, for such a fetch. */
  loadPolicyFile?: (url: string) => void;
  /** Security.sandboxType of the SWFs the element plays next: "remote" by default. */
  sandboxType?: string;
  /**
   * Whether the modules the compiler writes are kept in IndexedDB for the
   * page's next visit, which then links them without compiling: off by
   * default, as a first visit is some 9% slower for the writes.
   */
  cache?: boolean;
  /** Experimental AVM2 compilation on first method-factory use; off by default. */
  lazyCompilation?: boolean;
  /** Use native Wasm fill tessellation, with JS fallback; on by default. Applies to new playbacks. */
  nativeFills?: boolean;
  /**
   * What draws the stage: "pixi", the default, or "own", the renderer of
   * swf2es's own (docs/renderer.md), which takes WebGL 2. Applies to new
   * playbacks.
   */
  renderer?: "pixi" | "own";
  /** Use native Wasm BitmapData convolution, with JS fallback; on by default. Applies to new playbacks. */
  nativeBitmaps?: boolean;
  /** Experimental Stage3D surface factory; absent/null keeps ErrorEvent #3702. */
  stage3D?: Stage3DSurfaceFactory | null;
  /**
   * Whether flash.system.Worker runs a SWF's background workers, each on
   * a Web Worker: on by default, as in Flash; an element's `workers`
   * attribute decides for its own SWFs. Off, Worker.isSupported is false.
   * A shareable ByteArray, a Mutex or a Condition crosses to another
   * worker only on a cross-origin isolated page (docs/workers.md).
   */
  workers?: boolean;
  /**
   * The Web Workers' script: by default @swf2es/player-hosts'
   * dist/thread/player-hosts/web-worker.js beside the module the page
   * loaded @swf2es/player-hosts/workers from, which resolves its imports
   * without the page's import map. One of another origin, as a CDN's,
   * starts through a `blob:` module that imports it.
   */
  workerUrl?: string | URL;
  /** The page's build, a short commit or a version, which the context menu's About item names. */
  build?: string;
}

let config: Configuration = {};
let codegenModule: Promise<WebAssembly.Module> | null = null;
let libraryBytes: Promise<Uint8Array[]> | null = null;
let moduleCache: ModuleCache | null = null;

/**
 * Set the page's configuration, once, before the first player loads: what
 * is fetched is fetched once with the configuration of then. A second call
 * merges into the first, for a page whose parts each set their own; what
 * was already fetched stays.
 */
export function configure(options: Configuration): void {
  config = { ...config, ...options };
}

/** The configuration in force. */
export function configuration(): Readonly<Configuration> {
  return config;
}

/**
 * A compiler for one player. The page fetches and compiles codegen.wasm
 * once and every player instantiates that module: a Codegen holds one
 * player's domains, which a second player's reset would take over.
 */
export async function codegenForPlayer(): Promise<Codegen> {
  return createCodegen(await compiledCodegen());
}

/** codegen.wasm compiled, once a page. */
async function compiledCodegen(): Promise<WebAssembly.Module> {
  codegenModule ??= (async () => {
    const url = config.codegen ?? import.meta.resolve("@swf2es/codegen/codegen.wasm");
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`swf2es: codegen.wasm: ${response.status} from ${url}`);
    }

    return WebAssembly.compileStreaming(response);
  })();
  // A failed fetch is not kept: the next player tries again.
  return codegenModule.catch((error) => {
    codegenModule = null;
    throw error;
  });
}

/**
 * The Web Workers of one player, whose release (as the player goes) lets
 * the page's workers started ahead go once no player uses them. `ahead`
 * starts some ahead, for a SWF that may start a worker and wait for it at
 * once, as Crossbridge's do; others start one when the SWF asks.
 */
export async function workerHostForPlayer(ahead: boolean): Promise<WebWorkerHost> {
  // Loaded only where a SWF has workers: a page's import map that names no
  // @swf2es/player-hosts/workers still loads the element.
  const { webWorkerHost } = await import("@swf2es/player-hosts/workers");
  return webWorkerHost({
    codegen: await compiledCodegen(),
    url: config.workerUrl,
    spares: ahead ? undefined : 0,
  });
}

/** builtin.abc and playerglobal, fetched once a page; every player reads the same bytes. */
export function libraries(): Promise<Uint8Array[]> {
  const urls = config.libraries;
  if (!urls) {
    return Promise.reject(
      new Error("swf2es: this SWF has ActionScript 3; configure({ libraries }) to play it"),
    );
  }

  libraryBytes ??= Promise.all(
    [urls.builtin, urls.playerglobal ?? null].map(async (url) => {
      if (url === null) {
        return playerglobalLibrary;
      }

      const response = await fetch(url);
      // A missing one would reach codegen as an empty ABC, refused as if the SWF's.
      if (!response.ok) {
        throw new Error(`swf2es: ${response.status} for the library at ${url}`);
      }

      return new Uint8Array(await response.arrayBuffer());
    }),
  ).catch((error) => {
    libraryBytes = null;
    throw error;
  });

  return libraryBytes;
}

/** flash.net.Socket's host: the embedder's, through the configured relays, or none. */
export function socketHost(): SocketHost | undefined {
  if (config.sockets) {
    return config.sockets;
  }

  const proxy = config.socketProxy;
  if (!proxy) {
    return undefined;
  }

  const urlFor =
    typeof proxy === "function"
      ? proxy
      : (host: string, port: number) =>
          proxy.find((p) => p.host === host && p.port === port)?.proxyUrl ?? null;
  const relay = webSocketSocketHost((host, port) => urlFor(host, port) ?? "");
  return {
    connect(host, port, events) {
      if (urlFor(host, port) === null) {
        // Refused, as Flash reports a connection no server took.
        queueMicrotask(() => events.error("Error #2031: Socket Error."));
        return { send() {}, close() {} };
      }

      return relay.connect(host, port, events);
    },
  };
}

/** What Scripting is given for `cache`: one IndexedDB module cache, shared by every player on the page. */
export function moduleCacheOptions(): { moduleCache?: ModuleCache } {
  if (!config.cache || typeof indexedDB === "undefined") {
    return {};
  }

  moduleCache ??= indexedDbModuleCache();
  return { moduleCache };
}
