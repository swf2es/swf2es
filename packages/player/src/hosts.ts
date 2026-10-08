// What a host may give the player in place of the browser's: where a SWF's
// navigateToURL goes, where its SharedObjects are kept, and the system
// Capabilities reports; with the browser's defaults for each. Then what
// only a host can give, with no default here: ExternalInterface's page, a
// renderer's draws, fetches and sockets.
import type { avm2 } from "@swf2es/runtime";
import type { BitmapStore } from "./bitmap/bitmap.js";
import type { DisplayObject } from "./display/display.js";

type Value = avm2.Value;

/**
 * Opens the page a request asks for in the browser window or frame named,
 * "_self", "_blank", "_parent", "_top" or a name of the page's; null asks
 * for a new window, as Flash's does when no window is given.
 */
export type Navigate = (request: FetchRequest, window: string | null) => void;

/** Targets that would replace the player's own page or a frame around it. */
const IN_PLACE = new Set(["_self", "_parent", "_top", ""]);

/**
 * The browser's navigation, deliberately conservative, as a SWF is not to
 * be trusted by the page that embeds it: only an http: or https: URL opens,
 * so a javascript: one cannot run in the embedding page; a target that
 * would replace the page or a frame around it is refused, as Ruffle's web
 * navigator refuses it without script access; and every other target opens
 * a new window, since a name reaches the window or frame of that name,
 * noopener or not, so a SWF cannot reuse a window it named. A GET opens in
 * window.open without an opener; a POST is a form submitted to a new
 * window, the only way a browser posts into one, its body read as form
 * data. A host that trusts its SWFs further gives a navigate of its own.
 * Null where there is no window to open, as in node.
 */
export function browserNavigate(): Navigate | null {
  if (typeof globalThis.open !== "function" || typeof document === "undefined") {
    return null;
  }

  return (request, window) => {
    if (window !== null && IN_PLACE.has(window.toLowerCase())) {
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url, globalThis.location?.href);
    } catch {
      return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return;
    }

    if (request.method.toUpperCase() !== "POST" || !request.body) {
      globalThis.open(url.href, "_blank", "noopener");
      return;
    }

    if (!document.body) {
      return;
    }

    const form = document.createElement("form");
    form.method = "POST";
    form.action = url.href;
    form.target = "_blank";
    form.rel = "noopener";
    form.style.display = "none";
    for (const [name, value] of new URLSearchParams(new TextDecoder().decode(request.body))) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.append(input);
    }

    document.body.append(form);
    form.submit();
    form.remove();
  };
}

/**
 * Where the host keeps shared objects' bytes, by key: the browser's
 * localStorage by default, else memory.
 */
export interface SharedObjectStorage {
  get(key: string): Uint8Array | null;
  set(key: string, bytes: Uint8Array): void;
  remove(key: string): void;
  keys(): string[];
}

/**
 * The default storage: localStorage, base64 under a prefix, where the host
 * has it and lets it be read; memory otherwise. localStorage is first reached
 * when a SWF first uses a shared object, since merely reading it can throw
 * (a SecurityError where site data is blocked). A write it refuses, a full
 * quota say, throws, which flush reports as Error #2130.
 */
export function defaultStorage(): SharedObjectStorage {
  const memory = new Map<string, Uint8Array>();
  const inMemory: SharedObjectStorage = {
    get: (key) => memory.get(key) ?? null,
    set: (key, bytes) => {
      memory.set(key, bytes.slice());
    },
    remove: (key) => {
      memory.delete(key);
    },
    keys: () => [...memory.keys()],
  };
  let chosen: SharedObjectStorage | undefined;
  const storage = (): SharedObjectStorage => {
    if (!chosen) {
      let local: Storage | undefined;
      try {
        local = (globalThis as { localStorage?: Storage }).localStorage;
        local?.getItem(PREFIX);
      } catch {
        local = undefined;
      }

      chosen = local ? localStorageOf(local) : inMemory;
    }

    return chosen;
  };

  return {
    get: (key) => storage().get(key),
    set: (key, bytes) => storage().set(key, bytes),
    remove: (key) => storage().remove(key),
    keys: () => storage().keys(),
  };
}

const PREFIX = "swf2es:so:";

function localStorageOf(local: Storage): SharedObjectStorage {
  return {
    get: (key) => {
      const text = local.getItem(PREFIX + key);
      return text === null ? null : Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
    },
    set: (key, bytes) => {
      // In chunks: one String.fromCharCode of every byte overflows the stack.
      const parts: string[] = [];
      for (let i = 0; i < bytes.length; i += 0x2000) {
        parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x2000)));
      }

      local.setItem(PREFIX + key, btoa(parts.join("")));
    },
    remove: (key) => local.removeItem(PREFIX + key),
    keys: () => {
      const keys: string[] = [];
      for (let i = 0; i < local.length; i++) {
        const k = local.key(i);
        if (k?.startsWith(PREFIX)) {
          keys.push(k.slice(PREFIX.length));
        }
      }

      return keys;
    },
  };
}

/** What Capabilities reports of the system the player runs on. */
export interface PlatformCapabilities {
  /** "Windows 10", "Mac OS 10.15.7", "Linux"... */
  os: string;
  /** "Adobe Windows", "Adobe Macintosh" or "Adobe Linux". */
  manufacturer: string;
  /** The platform and the player's version: "WIN 32,0,0,465". */
  version: string;
  /** A language code: "en", or with its country for Chinese and Portuguese ("zh-CN"). */
  language: string;
  /** "PlugIn", "ActiveX", "StandAlone", "External" or "Desktop". */
  playerType: string;
}

/** The platform as the host's browser reports it, a Linux plugin's where it has none. */
export function platformCapabilities(): PlatformCapabilities {
  const navigator = (globalThis as { navigator?: { userAgent?: string; language?: string } })
    .navigator;
  const agent = navigator?.userAgent ?? "";
  const mac = /Mac OS X (\d+)[._](\d+)(?:[._](\d+))?/.exec(agent);
  const [os, manufacturer, platform] = /Windows/.test(agent)
    ? ["Windows 10", "Adobe Windows", "WIN"]
    : mac
      ? [`Mac OS ${mac[1]}.${mac[2]}${mac[3] ? `.${mac[3]}` : ""}`, "Adobe Macintosh", "MAC"]
      : ["Linux", "Adobe Linux", "LNX"];
  // Flash gives the country only where the language needs it.
  const tag = navigator?.language ?? "en";
  const [lang, country] = tag.split("-");
  const language = (lang === "zh" || lang === "pt") && country ? `${lang}-${country}` : lang;
  return { os, manufacturer, version: `${platform} 32,0,0,465`, language, playerType: "PlugIn" };
}

/** The host side of playerglobal's synchronous ExternalInterface protocol. */
export interface ExternalInterfaceHost {
  /** JavaScript source from playerglobal; the host decides whether to evaluate it. */
  evalJS(source: string): string | null;
  /** An XML invocation when evalJS declined the call. */
  callOut(request: string): string | null;
  /**
   * The SWF's callback `name`, playerglobal's wrapper of its closure, or
   * null as it is removed. Called with `args`, AVM2 values, the closure
   * gets them as they are and the result is JavaScript source (_toJS);
   * with null, `request` is an XML invocation, as Flash's plug-in sends
   * one, whose arguments playerglobal converts, and the result is XML
   * (_toXML) for a `returntype="xml"` request: a host needs no eval.
   */
  addCallback(
    name: string,
    callback: ((request: string, args: Value[] | null) => Value) | null,
  ): void;
  objectID?: string | null;
  /**
   * Whether the SWF at `url`, whose code is calling, may use the bridge, as
   * Flash checked allowScriptAccess against the calling SWF's domain, not
   * the main one's; one it refuses finds ExternalInterface unavailable.
   * Where the caller cannot be told, as from a timer, it is asked for every
   * loaded SWF, and all must be allowed. Every SWF may where this is left out.
   */
  allows?(url: string): boolean;
}

/** Screen values reported by flash.system.Capabilities, captured when the player starts. */
export interface ScreenCapabilities {
  screenResolutionX: number;
  screenResolutionY: number;
  pixelAspectRatio: number;
  screenDPI: number;
}

type Affine = { a: number; b: number; c: number; d: number; tx: number; ty: number };

/** A renderer's part in BitmapData.draw of a display object. */
export interface Drawer {
  /** `o` through `m` into a w x h texture at `samples` a side, read back as premultiplied ARGB. */
  snapshot(
    o: DisplayObject,
    m: Affine,
    width: number,
    height: number,
    samples: number,
  ): Uint32Array;
  /**
   * `o` the same, composited source over into `store` at (x, y) on the GPU,
   * left there until read; false, having done nothing, where it cannot.
   */
  drawInto(
    store: BitmapStore,
    o: DisplayObject,
    m: Affine,
    x: number,
    y: number,
    width: number,
    height: number,
    samples: number,
  ): boolean;
}

/** A host request's bytes and transport result; a local file reports status 0. */
export interface FetchResult {
  bytes: Uint8Array | null;
  status: number;
  headers: readonly (readonly [name: string, value: string])[];
  /** Set for `file:` URLs: Flash reports status 0 and leaves the URL out of #2032. */
  local?: boolean;
  /** The URL the bytes came from, after any redirect, where it differs from the one asked for. */
  url?: string;
}

/** The request the player asks its host to send. */
export interface FetchRequest {
  url: string;
  method: string;
  headers: readonly (readonly [name: string, value: string])[];
  body: Uint8Array | null;
}

/** A TCP connection supplied by the embedding host. */
export interface SocketTransport {
  send(bytes: Uint8Array): void;
  close(): void;
}

/** A connection's ends, as Socket's localAddress, localPort, remoteAddress and remotePort read them. */
export interface SocketEndpoints {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
}

/** Transport notifications; the player delivers them to ActionScript on a frame. */
export interface SocketEvents {
  /** Opened, with its ends where the host knows them: a relay's are not the script's to see. */
  open(endpoints?: SocketEndpoints): void;
  data(bytes: Uint8Array): void;
  close(): void;
  error(message: string): void;
}

export interface SocketHost {
  connect(host: string, port: number, events: SocketEvents): SocketTransport;
}

/** A WebSocket client connection opened by the host for air.net.WebSocket. */
export interface WebSocketTransport {
  /** A text message as a string, a binary one as bytes. */
  send(data: string | Uint8Array): void;
  /** A close frame with `code`, 1000 or 3000 to 4999, or with none. */
  close(code?: number): void;
}

/** What befalls the connection; the player delivers each to ActionScript on a frame. */
export interface WebSocketEvents {
  /** The handshake is done; the subprotocol the server chose, or "". */
  open(protocol: string): void;
  message(data: string | Uint8Array): void;
  /** The connection has closed: the close frame's code, 1005 for a frame without one, 1006 for none. */
  close(code: number): void;
  /** The connection or its handshake failed; after open, a close follows. */
  error(): void;
}

export interface WebSocketHost {
  /** Opens `url`, offering `protocols`; may throw as the WebSocket constructor does. */
  connect(url: string, protocols: string[], events: WebSocketEvents): WebSocketTransport;
}

/** The global WebSocket's client, a browser's or node's; null where there is none. */
export function globalWebSocketHost(): WebSocketHost | null {
  const Client = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (typeof Client !== "function") {
    return null;
  }

  return {
    connect(url, protocols, events) {
      const socket = new Client(url, protocols);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => events.open(socket.protocol));
      socket.addEventListener("message", ({ data }) => {
        events.message(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
      });
      socket.addEventListener("close", ({ code }) => events.close(code));
      socket.addEventListener("error", () => events.error());

      return {
        // The natives send bytes of their own, never a view of a shared buffer.
        send: (data) => socket.send(data as string | Uint8Array<ArrayBuffer>),
        close: (code) => socket.close(code),
      };
    },
  };
}

/**
 * A module as a ModuleCache keeps it: its source, what compiling it fixed
 * in the compiler's domain (Codegen.compileModuleLogged), which the player
 * replays in place of compiling it, and the two's lengths, which it checks.
 */
export interface CachedModule {
  module: string;
  log: string;
  lengths: [module: number, log: number];
  /**
   * An absolute URL to import the module from, as an ES module, in place
   * of evaluating `module`, which is then not read: for a page whose
   * Content-Security-Policy refuses 'unsafe-eval'. A document keeps what
   * it imports for as long as it lives.
   */
  url?: string;
}

/**
 * Where a host keeps the modules the compiler wrote, across page loads, so
 * that a SWF loaded again is not compiled again (see Code). Keys name the
 * compiler by the identity its codegen.wasm was stamped with, and a
 * compiler without one uses no cache. Each call may fail or answer
 * nothing; the player then compiles, as without one.
 */
export interface ModuleCache {
  /**
   * The smallest ABC, in bytes, whose module the player asks this cache
   * for; 8 KB by default, below which a key, a read and a replay cost
   * about what a compile does. A cache that holds modules compiled ahead
   * of time asks for every one, so that none is compiled.
   */
  readonly minBytes?: number;
  /** The module stored under `key`, if any. */
  get(key: string): Promise<CachedModule | undefined>;
  /** Store `entry` under `key`; a store that is full may evict others, or refuse it. */
  put(key: string, entry: CachedModule): Promise<void>;
  /**
   * Let go of what is stored under `key`, as a module that loaded part of
   * itself and failed; `entry`, where given, is the one this cache's get
   * answered that the player could not use, as a chain of caches needs to
   * tell which of its members gave it.
   */
  delete(key: string, entry?: CachedModule): Promise<void>;
}

/** What goes to or comes from the system's clipboard: text, and HTML where there is some. */
export interface ClipboardText {
  text: string;
  html?: string;
}

/**
 * The system's clipboard, written outside a copy event: what a script
 * puts there with System.setClipboard or Clipboard.setData in a mouse or
 * key handler. A copy or cut event the host binds (bindKeyboard) carries
 * its own data, and a paste brings the clipboard's with it, so nothing
 * here reads, as Flash read only in a paste.
 */
export interface ClipboardHost {
  /** Puts `data` on the clipboard; may fail quietly, as a browser refuses it without a user's gesture. */
  write(data: ClipboardText): void;
}

/**
 * The browser's async Clipboard API, which writes during a user's gesture
 * without asking; HTML only where ClipboardItem takes it, else the text
 * alone. Null where there is none, as in node.
 */
export function browserClipboard(): ClipboardHost | null {
  const clipboard = (globalThis as { navigator?: { clipboard?: Clipboard } }).navigator?.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") {
    return null;
  }

  const Item = (globalThis as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  return {
    write: ({ text, html }) => {
      const written =
        html !== undefined && Item && typeof clipboard.write === "function"
          ? clipboard.write([
              new Item({
                "text/plain": new Blob([text], { type: "text/plain" }),
                "text/html": new Blob([html], { type: "text/html" }),
              }),
            ])
          : clipboard.writeText(text);
      written.catch(() => {});
    },
  };
}
