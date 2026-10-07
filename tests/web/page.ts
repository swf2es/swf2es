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
const calls: { hello: unknown[][]; reports: unknown[] } = { hello: [], reports: [] };
const page = globalThis as unknown as Record<string, unknown>;
page.pageHello = (...args: unknown[]) => {
  calls.hello.push(args);
  return { got: args };
};
page.report = (value: unknown) => {
  calls.reports.push(value);
};

// After the fakes: the element is defined, and the page's players start, as it loads.
const web = await import("@swf2es/web");
web.configure({
  libraries: { builtin: "/libraries/builtin.abc", playerglobal: "/libraries/playerglobal.abc" },
  socketProxy: [{ host: "example.test", port: 1234, proxyUrl: "ws://relay.invalid/" }],
  cache: true,
});
const replaced = web.replaceFlash();

type Player = InstanceType<typeof web.Swf2esPlayerElement>;
const players = () => [...document.querySelectorAll<Player>("swf2es-player")];
const frames = (n: number) =>
  new Promise<void>((done) => {
    const step = (left: number) =>
      left === 0 ? done() : requestAnimationFrame(() => step(left - 1));
    step(n);
  });

/** Each player once all have played or failed, with what the test checks of it. */
async function booted() {
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
function replacement() {
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
  };
}

/** Destroy the scripted SWF: its callbacks leave the element, and its socket and audio close. */
function destroyMovie() {
  const movie = element("movie");
  const player = movie.player;
  movie.destroy();
  return {
    callbacks: ["echo", "add", "fail"].filter((name) => name in movie),
    player: movie.player === null,
    destroyed: player?.destroyed ?? false,
    counts: { ...counts },
  };
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

/** watchFlash, then an <embed> the page adds: what it became once the observer ran. */
async function watched() {
  const stop = web.watchFlash();
  const embed = document.createElement("embed");
  embed.setAttribute("src", "/web-test/shapes.swf");
  embed.id = "added";
  document.body.append(embed);
  await new Promise((done) => setTimeout(done, 0));
  stop();
  const added = element("added");
  await added.ready;
  return { tag: added.localName, playing: added.player !== null };
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

Object.assign(globalThis, {
  databases,
  booted,
  replacement,
  externalInterface,
  destroyMovie,
  resize,
  watched,
  churn,
  survivors,
  webCounts: () => ({ ...counts }),
});
