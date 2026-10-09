import type { Swf2esPlayerElement } from "@swf2es/web";

// The web test's page (run.ts writes its HTML): <swf2es-player>s and Flash
// tags for replaceFlash, the page's functions the SWF calls, and what
// run.ts asks of them. What the players hold is counted where they reach
// the browser: codegen.wasm's fetches and compiles, the WebSockets a
// socket relay opens, the AudioContexts, and the codegen instances.

interface Counts {
  codegenFetches: number;
  codegenCompiles: number;
  libraryFetches: number;
  /** Relay WebSockets, AudioContexts and codegen instances not yet let go of. */
  openSockets: number;
  socketsMade: number;
  openAudio: number;
  audioMade: number;
}

const counts: Counts = {
  codegenFetches: 0,
  codegenCompiles: 0,
  libraryFetches: 0,
  openSockets: 0,
  socketsMade: 0,
  openAudio: 0,
  audioMade: 0,
};

const pageFetch = fetch.bind(globalThis);
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("codegen.wasm")) {
    counts.codegenFetches++;
  }

  if (url.endsWith(".abc")) {
    counts.libraryFetches++;
  }

  return pageFetch(input, init);
};

const compileStreaming = WebAssembly.compileStreaming.bind(WebAssembly);
WebAssembly.compileStreaming = (source) => {
  counts.codegenCompiles++;
  return compileStreaming(source);
};

/** Each codegen instance's memory, held weakly: what is still alive after a collection was not let go. */
const memories: WeakRef<WebAssembly.Memory>[] = [];
const instantiate = WebAssembly.instantiate.bind(WebAssembly);
WebAssembly.instantiate = (async (module: WebAssembly.Module, imports?: WebAssembly.Imports) => {
  const instance = await instantiate(module, imports);
  const memory = instance.exports.memory;
  if (memory instanceof WebAssembly.Memory) {
    memories.push(new WeakRef(memory));
  }

  return instance;
}) as typeof WebAssembly.instantiate;

/**
 * The relay's WebSocket: it never connects, there being no relay, and it
 * lets go of its listeners as it closes, as a closed socket does.
 */
class RelaySocket extends EventTarget {
  binaryType = "blob";
  readyState = 0;
  private listening: [string, EventListenerOrEventListenerObject | null][] = [];

  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    counts.openSockets++;
    counts.socketsMade++;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    this.listening.push([type, listener]);
    super.addEventListener(type, listener);
  }

  send(): void {}

  close(): void {
    if (this.readyState === 3) {
      return;
    }

    this.readyState = 3;
    counts.openSockets--;
    for (const [type, listener] of this.listening.splice(0)) {
      super.removeEventListener(type, listener);
    }
  }
}
(globalThis as { WebSocket: unknown }).WebSocket = RelaySocket;

const PageAudio = globalThis.AudioContext;
globalThis.AudioContext = class extends PageAudio {
  private open = true;

  constructor(options?: AudioContextOptions) {
    super(options);
    counts.openAudio++;
    counts.audioMade++;
  }

  close(): Promise<void> {
    if (this.open) {
      this.open = false;
      counts.openAudio--;
    }

    return super.close();
  }
};

/** What the SWFs asked of the page: pageHello's arguments, and each report. */
const calls: { hello: unknown[][]; reports: unknown[]; captured: unknown[] } = {
  hello: [],
  reports: [],
  captured: [],
};
const page = globalThis as unknown as Record<string, unknown>;
page.pageHello = (...args: unknown[]) => {
  calls.hello.push(args);
  return { got: args };
};
page.pageCapture = (value: unknown) => {
  calls.captured.push(value);
};
page.report = (value: unknown) => {
  calls.reports.push(value);
};

// After the fakes: the element is defined, and the page's players start,
// as the package loads. The functions run.ts calls are there before it: a
// cold start of its many modules on a loaded machine is waited for by the
// checks, and a load that fails is their error, not a page that never ran.
const loading = import("@swf2es/web").then((web) => {
  web.configure({
    libraries: { builtin: "/libraries/builtin.abc", playerglobal: "/libraries/playerglobal.abc" },
    socketProxy: [{ host: "example.test", port: 1234, proxyUrl: "ws://relay.invalid/" }],
    cache: true,
  });
  return { web, replaced: web.replaceFlash() };
});
loading.catch(() => {});

type Player = Swf2esPlayerElement;
const players = () => [...document.querySelectorAll<Player>("swf2es-player")];
const frames = (n: number) =>
  new Promise<void>((done) => {
    const step = (left: number) =>
      left === 0 ? done() : requestAnimationFrame(() => step(left - 1));
    step(n);
  });

/** Each player once all have played or failed, with what the test checks of it. */
/** Once the package has loaded: null, else why not, its error's text. */
async function loaded(): Promise<string | null> {
  try {
    // Generous for a cold start on a loaded machine, but never for ever.
    await Promise.race([
      loading,
      new Promise((_, fail) =>
        setTimeout(() => fail(new Error("@swf2es/web did not load within 180 s")), 180_000),
      ),
    ]);
    return null;
  } catch (e) {
    return String(e);
  }
}

async function booted() {
  const failure = await loaded();
  if (failure !== null) {
    throw new Error(failure);
  }

  const outcomes = await Promise.all(
    players().map((p) =>
      p.ready.then(
        () => null,
        (e: unknown) => String(e),
      ),
    ),
  );
  await frames(3);
  return players().map((p, i) => {
    const canvas = p.shadowRoot?.querySelector("canvas");
    const box = p.getBoundingClientRect();
    return {
      id: p.id,
      error: outcomes[i],
      attributes: Object.fromEntries([...p.attributes].map((a) => [a.name, a.value])),
      rect: [box.left, box.top, box.width, box.height],
      canvas: canvas ? [canvas.width, canvas.height] : null,
      canvasCss: canvas ? [canvas.style.width, canvas.style.height] : null,
    };
  });
}

function element(id: string): Player & Record<string, (...args: unknown[]) => unknown> {
  return document.getElementById(id) as Player & Record<string, (...args: unknown[]) => unknown>;
}

/** The page's view of replaceFlash: what is left of the Flash tags, and what it made. */
async function replacement() {
  const { replaced } = await loading;
  return {
    replaced: replaced.map((p) => p.id),
    objects: document.querySelectorAll("object, embed").length,
    fallback: document.body.textContent?.includes("Get Flash Player") ?? false,
    players: players().length,
  };
}

/** ExternalInterface both ways, on the scripted SWF and the one the page forbids it. */
function externalInterface() {
  const movie = element("movie");
  const locked = element("locked");
  let failed = "";
  try {
    movie.fail();
  } catch (e) {
    failed = String(e);
  }

  return {
    // Dates as their JSON, which DevTools' values have no form for.
    calls: JSON.parse(JSON.stringify(calls)),
    echo: movie.echo([1, { a: "b" }, "x<y"]),
    add: movie.add(2, 3),
    failed,
    lockedCallbacks: ["echo", "add", "fail"].filter((name) => name in locked),
    // The SWF's callbacks of these names are refused: the element's own stay.
    shadowed: ["destroy", "getAttribute", "dispatchEvent", "then"].filter((name) =>
      Object.hasOwn(movie, name),
    ),
    attribute: movie.getAttribute("id"),
    // An object key written into JavaScript as code: never run.
    pwned: "swf2esPwned" in globalThis,
  };
}

/** Destroy the scripted SWF: its callbacks leave the element, and its socket and audio close. */
async function destroyMovie() {
  const movie = element("movie");
  const player = movie.player;
  // A callback the page kept, and the element awaited: a `then` the SWF added was refused.
  const kept = movie.echo;
  const awaited = (await Promise.resolve(movie)) === movie;
  movie.destroy();
  return {
    kept: kept(1) === undefined,
    awaited,
    callbacks: ["echo", "add", "fail"].filter((name) => name in movie),
    player: movie.player === null,
    destroyed: player?.destroyed ?? false,
    counts: { ...counts },
  };
}

/**
 * A player loading through the embedder's fetch: the requests it was
 * asked, by purpose, and whether the SWF played. The fetch is taken away
 * again, so the other players keep the browser's.
 */
async function embedderFetch() {
  const { web } = await loading;
  const asked: [string, string | undefined][] = [];
  web.configure({
    fetch: async (request, signal) => {
      asked.push([new URL(request.url).pathname, request.purpose]);
      const response = await pageFetch(request.url, { signal });
      return {
        bytes: response.ok ? new Uint8Array(await response.arrayBuffer()) : null,
        status: response.status,
        headers: [],
      };
    },
  });
  const player = document.createElement("swf2es-player") as Player;
  document.body.append(player);
  let played = true;
  try {
    await player.load("/web-test/shapes.swf");
  } catch {
    played = false;
  } finally {
    web.configure({ fetch: undefined });
    player.remove();
  }

  return { asked, played };
}

/** Pixels per CSS pixel and the scripted SWF's canvas after the page widens it. */
async function resize() {
  const movie = element("movie");
  movie.setAttribute("width", "320");
  await frames(3);
  const canvas = movie.shadowRoot?.querySelector("canvas");
  return {
    dpr: devicePixelRatio,
    canvas: canvas ? [canvas.width, canvas.height] : null,
    css: canvas ? [canvas.style.width, canvas.style.height] : null,
  };
}

/** watchFlash, then an <embed> the page adds and gives a src after: what it became. */
async function watched() {
  const stop = (await loading).web.watchFlash();
  const embed = document.createElement("embed");
  embed.id = "added";
  document.body.append(embed);
  await new Promise((done) => setTimeout(done, 0));
  // Not Flash until a script gives it its movie.
  const before = document.getElementById("added")?.localName;
  embed.setAttribute("src", "/web-test/shapes.swf");
  await new Promise((done) => setTimeout(done, 0));
  stop();
  const added = element("added");
  await added.ready;
  return { before, tag: added.localName, playing: added.player !== null };
}

/** Kept weakly: the players of the elements made and destroyed, which a collection must take. */
const gone: WeakRef<object>[] = [];

/** Make an element for the scripted SWF, play it a few frames, and take it away, `n` times. */
async function churn(n: number) {
  for (let i = 0; i < n; i++) {
    const p = document.createElement("swf2es-player") as Player;
    p.setAttribute("src", "/web-test/embed.swf");
    p.setAttribute("allowscriptaccess", "always");
    p.id = `churn${i}`;
    document.body.append(p);
    await p.ready;
    await frames(2);
    if (p.player) {
      gone.push(new WeakRef(p.player));
    }

    p.remove();
    // Taken away, it destroys itself after the microtask that tells a move from a removal.
    await new Promise((done) => setTimeout(done, 0));
  }

  return { ...counts };
}

/** What a collection left: players made and destroyed still alive, and codegen instances. */
function survivors() {
  return {
    players: gone.filter((ref) => ref.deref()).length,
    codegens: memories.filter((ref) => ref.deref()).length,
    counts: { ...counts },
  };
}

/** The IndexedDB databases the page has: the module cache's, once a player stored a module. */
async function databases() {
  return (await indexedDB.databases()).map((d) => d.name);
}

/** What the page last saw copied from a player, read as the copy event went by. */
let copied: string | null = null;
document.addEventListener("copy", (e) => {
  copied = e.clipboardData?.getData("text/plain") ?? null;
});

/** The clipboard SWF in an element of its own, and a textarea of the page's beside it: where each is. */
async function clipboardPlayer() {
  const p = document.createElement("swf2es-player") as Player;
  p.id = "clip";
  p.setAttribute("src", "/web-test/clipboard.swf");
  p.setAttribute("allowscriptaccess", "always");
  document.body.append(p);
  const seed = document.createElement("textarea");
  seed.id = "seed";
  document.body.append(seed);
  await p.ready;
  await frames(2);
  const box = p.getBoundingClientRect();
  return [box.left, box.top];
}

/** The page's textarea focused, holding `text` selected, for a copy into the clipboard or a paste from it. */
function seedFocus(text: string) {
  const seed = document.getElementById("seed") as HTMLTextAreaElement;
  seed.value = text;
  seed.focus();
  seed.select();
  return true;
}

/** The clipboard element focused, and in its SWF its field or its box. */
function clipFocus(target: "Field" | "Box") {
  const p = element("clip");
  p.focus();
  p[`focus${target}`]();
  return true;
}

/** What the SWF heard since last asked, its field's text, what was copied, and the textarea's value. */
function clipState() {
  const p = element("clip");
  const state = {
    log: p.takeLog(),
    text: p.text(),
    copied,
    seed: (document.getElementById("seed") as HTMLTextAreaElement).value,
  };
  copied = null;
  return state;
}

function clipDestroy() {
  element("clip").destroy();
  document.getElementById("seed")?.remove();
  return true;
}

/** A player of the touch SWF, made once the test has given the page a touch screen; where its stage is. */
async function touchPlayer() {
  const p = document.createElement("swf2es-player") as Player;
  p.id = "touch";
  p.setAttribute("src", "/web-test/touch.swf");
  p.setAttribute("allowscriptaccess", "always");
  document.body.append(p);
  const seed = document.createElement("textarea");
  seed.id = "seed";
  document.body.append(seed);
  await p.ready;
  await frames(2);
  const box = p.getBoundingClientRect();
  return [
    box.left,
    box.top,
    getComputedStyle(p.shadowRoot?.querySelector("canvas") as Element).touchAction,
  ];
}

/** What the touch SWF heard since last asked, after the frame that handles a posted move. */
async function touchLog() {
  await frames(2);
  return element("touch").takeLog();
}

Object.assign(globalThis, {
  touchPlayer,
  touchLog,
  touchCall: (name: string, ...args: unknown[]) => element("touch")[name](...args),
  touchSeed: () => (document.getElementById("seed") as HTMLTextAreaElement).value,
  touchDestroy: () => {
    element("touch").destroy();
    // Gone from the page too: the next check makes a player of its own by the same id.
    element("touch").remove();
    document.getElementById("seed")?.remove();
    return true;
  },
  clipboardPlayer,
  seedFocus,
  clipFocus,
  clipState,
  clipDestroy,
  loaded,
  databases,
  booted,
  replacement,
  externalInterface,
  destroyMovie,
  resize,
  embedderFetch,
  watched,
  churn,
  survivors,
  webCounts: () => ({ ...counts }),
});
