// <swf2es-player>: a SWF on a page as an <embed> showed one, with the
// embedding's attributes, a load() and destroy() of its own, and the
// SWF's ExternalInterface callbacks as methods on the element.
import { isAs3, readSwf, tags } from "@swf2es/format";
import { type FetchRequest, type FetchResult, Player, Scripting } from "@swf2es/player";
import { codegenForPlayer, libraries, moduleCacheOptions, socketHost } from "./config.js";
import { externalInterfaceHost, type PageBridge, type PageValue } from "./external.js";
import { scaleMode } from "./layout.js";
import { type Look, Playback } from "./playback.js";

export const TAG = "swf2es-player";

/** What `load` takes: a URL, relative to the page, or the SWF's bytes. */
export type SwfSource = string | URL | ArrayBuffer | Uint8Array;

/** In node, which has no DOM, the module still loads, for its other exports. */
const ElementBase = (globalThis.HTMLElement ?? class {}) as typeof HTMLElement;

/** What one load holds, let go of all at once when the next load or destroy comes. */
interface Session {
  scripting: Scripting | null;
  player: Player | null;
  playback: Playback | null;
  /** The ExternalInterface callbacks the SWF put on the element. */
  callbacks: Set<string>;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  settled: boolean;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  // A page that never awaits `ready` should not hear of its failure as unhandled.
  promise.catch(() => {});
  const d: Deferred = {
    promise,
    settled: false,
    resolve: () => {
      d.settled = true;
      resolve();
    },
    reject: (error) => {
      d.settled = true;
      reject(error);
    },
  };
  return d;
}

/** "550" is pixels, as an <embed>'s width is; "100%" and other CSS lengths are themselves. */
function cssLength(value: string | null): string | null {
  if (value === null || value.trim() === "") {
    return null;
  }

  return /^\s*\d+(\.\d+)?\s*$/.test(value) ? `${Number(value)}px` : value.trim();
}

/** A colour as Flash's bgcolor gives it, "#RRGGBB" or "RRGGBB"; null for none or another form. */
export function parseColor(value: string | null): number | null {
  const hex = /^\s*#?([0-9a-f]{6})\s*$/i.exec(value ?? "")?.[1];
  return hex ? Number.parseInt(hex, 16) : null;
}

/** FlashVars, "name=value&...", URL-encoded, as Flash read them. */
export function parseFlashVars(value: string | null): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, text] of new URLSearchParams(value ?? "")) {
    vars[name] = text;
  }

  return vars;
}

/**
 * Whether a SWF from `swfUrl` may script its page, by allowScriptAccess as
 * Flash read it: "always", "never", or by default "sameDomain", the SWF's
 * origin the page's.
 */
export function scriptAccess(value: string | null, swfUrl: string, pageUrl: string): boolean {
  switch (value?.toLowerCase()) {
    case "always":
      return true;
    case "never":
      return false;
    default:
      try {
        return new URL(swfUrl, pageUrl).origin === new URL(pageUrl).origin;
      } catch {
        return false;
      }
  }
}

/** Flash's quality names; the auto ones as what they start at. */
function quality(value: string | null): string {
  const named = (value ?? "high").toUpperCase();
  if (named === "AUTOLOW") {
    return "LOW";
  }

  return ["LOW", "MEDIUM", "HIGH", "BEST"].includes(named) ? named : "HIGH";
}

/** The host's fetch for what a SWF loads: the browser's, its status and headers as they come. */
async function browserFetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult> {
  const response = await fetch(request.url, {
    signal,
    method: request.method,
    headers: request.headers.map(([name, value]) => [name, value]),
    body: request.body ? new Uint8Array(request.body).buffer : null,
  });
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    headers.push([name, value]);
  });

  return {
    bytes: response.ok ? new Uint8Array(await response.arrayBuffer()) : null,
    status: response.status,
    headers,
  };
}

export class Swf2esPlayerElement extends ElementBase {
  static readonly observedAttributes = [
    "src",
    "width",
    "height",
    "scale",
    "salign",
    "wmode",
    "bgcolor",
    "quality",
  ];

  private session: Session | null = null;
  private readiness = deferred();
  /** The source the element last loaded, to tell a new src from the one playing. */
  private loaded: string | null = null;
  private readonly box: HTMLDivElement;
  private readonly sizing: HTMLStyleElement;
  /** The stage's size once a SWF is read, the element's own where the page gives it none. */
  private stageSize: [number, number] | null = null;

  constructor() {
    super();
    const shadow = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    // :host's rules give way to the page's, which may size it as it likes.
    style.textContent =
      ":host { display: inline-block; position: relative; overflow: hidden; outline: none }" +
      " .box { position: absolute; inset: 0; overflow: hidden }";
    this.sizing = document.createElement("style");
    this.box = document.createElement("div");
    this.box.className = "box";
    shadow.append(style, this.sizing, this.box);
    this.size();
    this.addEventListener("pointerdown", () => this.focus({ preventScroll: true }));
  }

  /** Resolves once the SWF loading, or the next one asked for, plays; rejects if it fails. */
  get ready(): Promise<void> {
    return this.readiness.promise;
  }

  /** The player playing, for a host that needs more than the element gives; null before a load and after destroy. */
  get player(): Player | null {
    return this.session?.player ?? null;
  }

  get src(): string {
    return this.getAttribute("src") ?? "";
  }

  set src(value: string) {
    this.setAttribute("src", value);
  }

  connectedCallback(): void {
    // Focusable, for the keys, as a plug-in's object was.
    if (!this.hasAttribute("tabindex")) {
      this.tabIndex = 0;
    }

    const src = this.getAttribute("src");
    if (src && !this.session) {
      void this.load(src);
    }
  }

  disconnectedCallback(): void {
    // Moved within the page, it is back by the time this runs; taken away, it stops.
    queueMicrotask(() => {
      if (!this.isConnected) {
        this.destroy();
      }
    });
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (old === value) {
      return;
    }

    if (name === "src") {
      if (value && this.isConnected && value !== this.loaded) {
        void this.load(value);
      }

      return;
    }

    if (name === "width" || name === "height") {
      this.size();
    }

    if (name === "quality" && this.session?.scripting) {
      this.session.scripting.quality = quality(value);
    }

    this.session?.playback?.changed();
  }

  /**
   * Play `source` in place of what plays now: a URL, relative to the page,
   * or the SWF's bytes. Resolves once it plays, and rejects with what kept
   * it from playing, as `ready` does; a load asked for before it played
   * settles it in its place.
   */
  load(source: SwfSource): Promise<void> {
    this.release();
    if (this.readiness.settled) {
      this.readiness = deferred();
    }

    const ready = this.readiness;
    const session: Session = {
      scripting: null,
      player: null,
      playback: null,
      callbacks: new Set(),
    };
    this.session = session;
    this.loaded = typeof source === "string" || source instanceof URL ? String(source) : null;
    void this.start(source, session, ready);
    return ready.promise;
  }

  private async start(source: SwfSource, session: Session, ready: Deferred): Promise<void> {
    const current = () => this.session === session;
    try {
      const pageUrl = document.baseURI;
      const base = this.getAttribute("base");
      let bytes: Uint8Array;
      let url: string;
      if (typeof source === "string" || source instanceof URL) {
        url = new URL(source, pageUrl).href;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`swf2es: ${response.status} for ${url}`);
        }

        bytes = new Uint8Array(await response.arrayBuffer());
        url = response.url || url;
      } else {
        // A copy: the page may reuse its buffer.
        bytes = new Uint8Array(source instanceof Uint8Array ? source : new Uint8Array(source));
        url = base ? new URL(base, pageUrl).href : pageUrl;
      }

      if (!current()) {
        return;
      }

      const swf = readSwf(bytes);
      this.stageSize = [
        Math.round((swf.frameSize.xMax - swf.frameSize.xMin) / 20),
        Math.round((swf.frameSize.yMax - swf.frameSize.yMin) / 20),
      ];
      this.size();
      const scripted =
        isAs3(swf) && swf.tags.some((t) => t.code === tags.DoABC || t.code === tags.DoABC2);
      if (scripted) {
        const [codegen, abcs] = await Promise.all([codegenForPlayer(), libraries()]);
        if (!current()) {
          return;
        }

        session.scripting = this.scripting(session, codegen, url, pageUrl);
        await session.scripting.loadLibraries(abcs);
        if (!current()) {
          return;
        }
      }

      session.player = new Player(bytes, session.scripting);
      const playback = await Playback.create(
        this.box,
        session.player,
        session.scripting,
        quality(this.getAttribute("quality")) !== "LOW",
        () => this.look(),
        (error) => this.report(session, error),
      );
      if (!current()) {
        playback.destroy();
        return;
      }

      session.playback = playback;
      await session.player.start();
      if (!current()) {
        return;
      }

      playback.run();
      ready.resolve();
      this.dispatchEvent(new Event("load"));
    } catch (error) {
      if (!current()) {
        return;
      }

      this.release();
      ready.reject(error);
      this.dispatchEvent(new CustomEvent("error", { detail: { error } }));
    }
  }

  /** The scripting of a load from `url`, its ExternalInterface and fscommand the page's only where it lets the SWF script it. */
  private scripting(
    session: Session,
    codegen: Awaited<ReturnType<typeof codegenForPlayer>>,
    url: string,
    pageUrl: string,
  ): Scripting {
    const allowed = scriptAccess(this.getAttribute("allowscriptaccess"), url, pageUrl);
    const base = this.getAttribute("base");
    const objectID = this.id || this.getAttribute("name") || null;
    const bridge: PageBridge = {
      objectID,
      callback: (name, call) => this.callback(session, name, call),
    };
    const scripting = new Scripting(codegen, {
      url,
      base: base ? new URL(base, pageUrl).href : undefined,
      parameters: parseFlashVars(this.getAttribute("flashvars")),
      fetch: browserFetch,
      socket: socketHost(),
      externalInterface: allowed
        ? externalInterfaceHost(bridge, (error) => this.report(session, error))
        : undefined,
      fsCommand: allowed ? (command, args) => this.fsCommand(objectID, command, args) : null,
      onUncaught: (error) => this.report(session, error),
      ...moduleCacheOptions(),
    });
    scripting.quality = quality(this.getAttribute("quality"));
    return scripting;
  }

  /** The SWF's callback `name` on the element, or taken off it, while its load is the one playing. */
  private callback(
    session: Session,
    name: string,
    call: ((...args: PageValue[]) => PageValue) | null,
  ): void {
    if (this.session !== session) {
      return;
    }

    if (call) {
      Object.defineProperty(this, name, {
        value: call,
        configurable: true,
        writable: true,
        enumerable: false,
      });
      session.callbacks.add(name);
    } else if (session.callbacks.delete(name)) {
      Reflect.deleteProperty(this, name);
    }
  }

  /** fscommand as Flash's plug-in delivered it, to the page's `<id>_DoFSCommand`, and as an event. */
  private fsCommand(objectID: string | null, command: string, args: string): void {
    this.dispatchEvent(new CustomEvent("fscommand", { detail: { command, args } }));
    const handler = objectID
      ? (globalThis as Record<string, unknown>)[`${objectID}_DoFSCommand`]
      : undefined;
    if (typeof handler === "function") {
      handler(command, args);
    }
  }

  /** An error the SWF's code threw and nothing caught: told, as Flash's debugger told it, and played on. */
  private report(session: Session, error: unknown): void {
    let text: string;
    try {
      text = session.scripting ? session.scripting.rt.toString(error as never) : String(error);
    } catch {
      text = String(error);
    }

    console.error(`swf2es: ${text}`);
  }

  private look(): Look {
    return {
      scale: scaleMode(this.getAttribute("scale")),
      salign: this.getAttribute("salign"),
      wmode: (this.getAttribute("wmode") ?? "window").toLowerCase(),
      bgcolor: parseColor(this.getAttribute("bgcolor")),
    };
  }

  /** The element's size: its width and height attributes, else its SWF's stage, else Flash's default stage. */
  private size(): void {
    const [w, h] = this.stageSize ?? [550, 400];
    const width = cssLength(this.getAttribute("width")) ?? `${w}px`;
    const height = cssLength(this.getAttribute("height")) ?? `${h}px`;
    this.sizing.textContent = `:host { width: ${width}; height: ${height} }`;
  }

  /**
   * Stop the SWF and let go of everything it holds: its frames, sounds and
   * audio device, its open sockets and fetches, the renderer and its GL
   * context, the pointer, the keys, and its callbacks on the element. The
   * element stays, and may load another.
   */
  destroy(): void {
    const loading = this.session !== null && !this.readiness.settled;
    this.release();
    this.loaded = null;
    if (loading) {
      this.readiness.reject(new Error("swf2es: destroyed before it played"));
    }
  }

  private release(): void {
    const session = this.session;
    if (!session) {
      return;
    }

    this.session = null;
    for (const name of session.callbacks) {
      Reflect.deleteProperty(this, name);
    }

    session.callbacks.clear();
    session.playback?.destroy();
    session.player?.destroy();
    session.scripting?.destroy();
    this.box.style.background = "";
  }
}

/** Define the element as `name`, once; what a page or extension calls before using it, if index.js has not. */
export function defineElement(name = TAG): void {
  if (typeof customElements !== "undefined" && !customElements.get(name)) {
    // A class of its own for each name: a registry takes a constructor once.
    customElements.define(name, class extends Swf2esPlayerElement {});
  }
}
