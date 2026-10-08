import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import type { ExternalInterfaceHost } from "../../../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { externalInterfaceNatives } from "../../../../../../packages/player/dist/playerglobal/flash/external/ExternalInterface.js";
import type { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { Scripting as PlayerScripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compiler } from "../../../../../player/scripts.ts";

const CLASS = "flash.external::ExternalInterface";
const PRIVATE = `${CLASS}.flash.external:ExternalInterface::`;

function scripting(host: ExternalInterfaceHost | null): Scripting {
  const rt = {
    toString: String,
    array: (values: unknown[]) => ({ $a: values }),
    callValue: (
      closure: { $f: (...args: unknown[]) => unknown },
      _receiver: unknown,
      args: unknown[],
    ) => closure.$f(...args),
    error: (_name: string, id: number) => new Error(`Error #${id}`),
    hasNext: (_object: unknown, index: number) => (index < 2 ? index + 1 : 0),
    nextName: (_object: unknown, index: number) => ["first", "second"][index - 1],
  };
  return { rt, externalInterface: host, hostCalls: 0 } as unknown as Scripting;
}

test("ExternalInterface reports an unavailable host and keeps callbacks per player", () => {
  const unavailable = scripting(null);
  const absent = externalInterfaceNatives(unavailable);
  assert.equal(absent[`${CLASS}.get:available`](unavailable.rt).call(null), false);
  assert.equal(absent[`${CLASS}.get:objectID`](unavailable.rt).call(null), null);
  assert.throws(
    () => absent[`${PRIVATE}_evalJS`](unavailable.rt).call(null, "source"),
    /Error #2067/,
  );

  const calls: string[] = [];
  const callbacks: { current: ((request: string, args: unknown[] | null) => unknown) | null } = {
    current: null,
  };
  const first = scripting({
    objectID: "first",
    evalJS(source) {
      calls.push(`eval ${source}`);
      return null;
    },
    callOut(request) {
      calls.push(`call ${request}`);
      return "<null/>";
    },
    addCallback(name, value) {
      calls.push(`callback ${name}`);
      callbacks.current = value;
    },
  });
  const second = scripting({
    objectID: "second",
    evalJS: () => "<undefined/>",
    callOut: () => null,
    addCallback: () => {},
  });
  const a = externalInterfaceNatives(first);
  const b = externalInterfaceNatives(second);

  assert.equal(a[`${CLASS}.get:available`](first.rt).call(null), true);
  assert.equal(a[`${CLASS}.get:objectID`](first.rt).call(null), "first");
  assert.equal(b[`${CLASS}.get:objectID`](second.rt).call(null), "second");
  assert.equal(
    a[`${CLASS}.get:flash.external:ExternalInterface::activeX`](first.rt).call(null),
    false,
  );
  assert.equal(a[`${PRIVATE}_initJS`](first.rt).call(null), undefined);
  assert.deepEqual(a[`${PRIVATE}_getPropNames`](first.rt).call(null, {}), {
    $a: ["first", "second"],
  });
  assert.equal(a[`${PRIVATE}_evalJS`](first.rt).call(null, "source"), null);
  assert.equal(a[`${PRIVATE}_callOut`](first.rt).call(null, "<invoke/>"), "<null/>");
  assert.deepEqual(calls, ["eval source", "call <invoke/>"]);

  const closure = {
    $f: (request: string, args: { $a: unknown[] } | null) => `${request}:${args?.$a ?? "none"}`,
  };
  a[`${PRIVATE}_addCallback`](first.rt).call(null, "ready", closure, false);
  assert.equal(callbacks.current?.("message", [1, 2]), "message:1,2");
  // A call from the page runs outside a frame: a change a host draws for.
  assert.equal(first.hostCalls, 1);
  // An XML invocation alone: playerglobal's _callIn reads its arguments from it.
  assert.equal(callbacks.current?.("<invoke/>", null), "<invoke/>:none");
  a[`${PRIVATE}_addCallback`](first.rt).call(null, "ready", closure, true);
  assert.equal(callbacks.current, null);
  assert.deepEqual(calls.slice(2), ["callback ready", "callback ready"]);
  assert.equal(first.hostCalls, 2);
});

test("ExternalInterface quotes JavaScript string and error arguments", () => {
  const s = scripting(null);
  const natives = externalInterfaceNatives(s);
  const quote = natives[`${PRIVATE}_quotedStringFromString`](s.rt);
  const quoteError = natives[`${PRIVATE}_quotedStringFromError`](s.rt);
  const value = 'quote " slash \\ newline \n tab \t null \0';

  assert.equal(JSON.parse(quote.call(null, value) as string), value);
  assert.equal(quote.call(null, value), JSON.stringify(value));
  assert.equal(
    JSON.parse(quoteError.call(null, new Error("bad input")) as string),
    "Error: bad input",
  );
});

test("ExternalInterface asks the host whether the calling SWF may use it", () => {
  const callers: string[] = [];
  let caller = "http://page.test/main.swf";
  const s = scripting({
    objectID: "movie",
    evalJS: () => "<null/>",
    callOut: () => null,
    addCallback: () => {},
    allows: (url) => {
      callers.push(url);
      return url.startsWith("http://page.test/");
    },
  });
  (s as unknown as { code: { securityUrls(): string[] } }).code = { securityUrls: () => [caller] };
  const natives = externalInterfaceNatives(s);
  assert.equal(natives[`${CLASS}.get:available`](s.rt).call(null), true);
  assert.equal(natives[`${PRIVATE}_evalJS`](s.rt).call(null, "source"), "<null/>");

  // A child from another origin, which the main SWF loaded: as if there were no bridge.
  caller = "http://other.test/child.swf";
  assert.equal(natives[`${CLASS}.get:available`](s.rt).call(null), false);
  assert.equal(natives[`${CLASS}.get:objectID`](s.rt).call(null), null);
  assert.throws(() => natives[`${PRIVATE}_evalJS`](s.rt).call(null, "source"), /Error #2067/);
  assert.throws(
    () => natives[`${PRIVATE}_addCallback`](s.rt).call(null, "x", { $f: () => 1 }, false),
    /Error #2067/,
  );
  assert.deepEqual(
    new Set(callers),
    new Set(["http://page.test/main.swf", "http://other.test/child.swf"]),
  );
});

const out = fileURLToPath(new URL("../../../../out/player-external/", import.meta.url));
let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const wasmBytes = async () =>
  WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );

/** A document class `name` whose constructor runs `body`, with the imports the cases below use. */
const sprite = (name: string, body: string) => `package {
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.external.ExternalInterface;
  import flash.net.URLLoader;
  import flash.net.URLLoaderDataFormat;
  import flash.net.URLRequest;
  import flash.system.fscommand;
  import flash.utils.setTimeout;
  public class ${name} extends Sprite {
    public function ${name}() {
      ${body}
    }
  }
}`;

/** `main` played with `children` served by URL, the host allowing page.test's SWFs alone: what reached it. */
async function play(
  main: Uint8Array,
  children: Record<string, Uint8Array | { bytes: Uint8Array; redirect: string }>,
  frames = 6,
  between?: (frame: number) => Promise<void>,
) {
  const lines: string[] = [];
  const evaluated: string[] = [];
  const commands: { command: string; callers: string[] }[] = [];
  const uncaught: string[] = [];
  const scripting = new PlayerScripting(await createCodegen(await wasmBytes()), {
    print: (line) => lines.push(line),
    url: "http://page.test/main.swf",
    // The frame clock: a timer of 1 ms fires in the next frame.
    realTime: null,
    fetch: async ({ url }) => {
      const served = children[url];
      return served instanceof Uint8Array || served === undefined
        ? { bytes: served ?? null, status: 200, headers: [] }
        : { bytes: served.bytes, status: 200, headers: [], url: served.redirect };
    },
    externalInterface: {
      evalJS: (source) => {
        evaluated.push(source);
        return "<undefined/>";
      },
      callOut: () => null,
      addCallback: () => {},
      allows: (url) => new URL(url).origin === "http://page.test",
    },
    fsCommand: (command, _args, callers) => commands.push({ command, callers }),
    onUncaught: (error) => uncaught.push(scripting.rt.toString(error as never)),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(main, scripting);
  await player.start();
  for (let i = 0; i < frames; i++) {
    await scripting.settled();
    player.tick();
    await between?.(i);
  }

  return { lines: lines.sort(), evaluated, commands, uncaught };
}

/** A main SWF that loads each of `urls` into a Loader on its display list. */
const loading = (compile: ReturnType<typeof compiler>, name: string, urls: string[]) =>
  bare(
    compile(
      name,
      sprite(
        name,
        `for each (var url:String in ${JSON.stringify(urls)}) {
        var loader:Loader = new Loader();
        loader.load(new URLRequest(url));
        addChild(loader);
      }`,
      ),
    ),
    1,
    name,
  );

test("a loaded SWF's calls are checked against its own URL, never falling back to the main SWF's", {
  skip,
}, async () => {
  const compile = compiler(out);
  const child = (name: string, body: string) => bare(compile(name, sprite(name, body)), 1, name);
  const result = await play(
    loading(compile, "EiLoader", ["http://page.test/same.swf", "http://other.test/child.swf"]),
    {
      "http://page.test/same.swf": child(
        "EiSameChild",
        `trace("EiSameChild", ExternalInterface.available);
      ExternalInterface.call("hello", "EiSameChild");`,
      ),
      "http://other.test/child.swf": child(
        "EiOtherChild",
        `trace("EiOtherChild", ExternalInterface.available);
      try {
        ExternalInterface.call("hello", "direct");
      } catch (e:Error) {
        trace("EiOtherChild", e.errorID);
      }
      // Bypass 1: only playerglobal's frames on the stack when the timer fires.
      setTimeout(ExternalInterface.call, 1, "hello", "timer");
      setTimeout(fscommand, 1, "timer", "");
      // Bypass 2: the child's frame past the engine's default ten.
      try {
        var names:Array = ["hello"];
        names.forEach(ExternalInterface.call);
      } catch (e:Error) {
        trace("forEach", e.errorID);
      }
      // Bypass 3: content from bytes, never on the display list.
      var stream:URLLoader = new URLLoader();
      stream.dataFormat = URLLoaderDataFormat.BINARY;
      stream.addEventListener(Event.COMPLETE, function (e:Event):void {
        new Loader().loadBytes(stream.data);
      });
      stream.load(new URLRequest("http://other.test/bytes.swf"));`,
      ),
      "http://other.test/bytes.swf": child(
        "EiBytes",
        `trace("EiBytes", ExternalInterface.available);
      try {
        ExternalInterface.call("hello", "bytes");
      } catch (e:Error) {
        trace("EiBytes", e.errorID);
      }`,
      ),
    },
  );

  // The page.test child's call alone reached the page; each of the other's
  // ways threw #2067 or, from a timer, which nothing catches, never got there.
  assert.equal(result.evaluated.length, 1);
  assert.match(result.evaluated[0], /hello\("EiSameChild"\)/);
  assert.ok(result.lines.includes("EiOtherChild 2067"));
  assert.ok(result.lines.includes("forEach 2067"));
  assert.ok(result.lines.includes("EiBytes false"));
  assert.ok(result.lines.includes("EiBytes 2067"));
  assert.ok(result.lines.includes("EiSameChild true"));
  // The timer's call, which nothing catches.
  assert.deepEqual(result.uncaught, ["Error: Error #2067"]);
  // The timer's fscommand could not be told from any loaded SWF's: the host is given them all.
  assert.deepEqual(
    result.commands.map((c) => [c.command, c.callers.sort()]),
    [
      [
        "timer",
        ["http://other.test/child.swf", "http://page.test/main.swf", "http://page.test/same.swf"],
      ],
    ],
  );
});

test("a call from a timer passes where every loaded SWF is allowed", { skip }, async () => {
  const compile = compiler(out);
  const main = bare(
    compile(
      "EiTimerOnly",
      sprite(
        "EiTimerOnly",
        `setTimeout(ExternalInterface.call, 1, "hello", "timer");
      var names:Array = ["hello"];
        names.forEach(ExternalInterface.call);`,
      ),
    ),
    1,
    "EiTimerOnly",
  );
  const result = await play(main, {});
  assert.equal(result.evaluated.length, 2);
  assert.deepEqual(result.uncaught, []);
});

test("a SWF a redirect took elsewhere is judged, and named, by where it came from", {
  skip,
}, async () => {
  const compile = compiler(out);
  const redirected = bare(
    compile(
      "EiRedirected",
      sprite(
        "EiRedirected",
        `trace(ExternalInterface.available);
      // Its LoaderInfo has its URL once the load completes.
      var info:Object = loaderInfo;
      setTimeout(function ():void {
        trace(info.url);
      }, 1);`,
      ),
    ),
    1,
    "EiRedirected",
  );
  const result = await play(
    loading(compile, "EiRedirectLoader", ["http://page.test/open-redirect.swf"]),
    {
      "http://page.test/open-redirect.swf": {
        bytes: redirected,
        redirect: "http://other.test/redirected.swf",
      },
    },
  );
  assert.deepEqual(result.lines, ["false", "http://other.test/redirected.swf"]);
});

test("a child's timers and loadBytes still count as its own once it is unloaded and collected", {
  skip,
}, async () => {
  const compile = compiler(out);
  const child = (name: string, body: string) => bare(compile(name, sprite(name, body)), 1, name);
  // The main SWF unloads its child at 200 ms, before the child's timers fire at 400 and 500.
  const main = bare(
    compile(
      "EiUnloader",
      sprite(
        "EiUnloader",
        `var l:Loader = new Loader();
      l.load(new URLRequest("http://other.test/child.swf"));
      addChild(l);
      setTimeout(function ():void {
        l.unload();
        removeChild(l);
        l = null;
      }, 200);`,
      ),
    ),
    1,
    "EiUnloader",
  );
  const result = await play(
    main,
    {
      "http://other.test/child.swf": child(
        "EiLeaver",
        `setTimeout(ExternalInterface.call, 400, "evil", "x");
      setTimeout(fscommand, 400, "cmd", "");
      // Off the display list, its bytes loaded from a timer once the child is gone.
      var off:Loader = new Loader();
      var stream:URLLoader = new URLLoader();
      stream.dataFormat = URLLoaderDataFormat.BINARY;
      stream.addEventListener(Event.COMPLETE, function (e:Event):void {
        setTimeout(off.loadBytes, 500, stream.data);
      });
      stream.load(new URLRequest("http://other.test/bytes.swf"));`,
      ),
      "http://other.test/bytes.swf": child(
        "EiOrphanBytes",
        `trace("bytes", ExternalInterface.available, loaderInfo.loaderURL);`,
      ),
    },
    30,
    async () => {
      // Collected between frames, as the review had it: the child's modules go.
      gc();
      await new Promise((done) => setImmediate(done));
      gc();
    },
  );

  // Repro 1: the timer's call never reaches the page; its fscommand names the child among its callers.
  assert.equal(result.evaluated.length, 0);
  assert.deepEqual(result.uncaught, ["Error: Error #2067"]);
  assert.deepEqual(
    result.commands.map((c) => c.callers),
    [["http://page.test/main.swf", "http://other.test/child.swf"]],
  );
  // Repro 2: content its Loader took from a timer is no one's, not the main SWF's.
  assert.deepEqual(result.lines, ["bytes false about:blank"]);
});

/**
 * A child that hands the main SWF ExternalInterface.call as a function
 * value four ways, and a main that runs them from its own code: a child
 * event it re-dispatches whose toString names the page function, an
 * Array's forEach and sort, and an event of its own a child listens for.
 */
function handOver(compile: ReturnType<typeof compiler>, childUrl: string) {
  const main = bare(
    compile(
      "EiHandMain",
      `package {
  import flash.display.Loader;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.net.URLRequest;
  public dynamic class EiHandMain extends Sprite {
    public function EiHandMain() {
      var loader:Loader = new Loader();
      loader.load(new URLRequest(${JSON.stringify(childUrl)}));
      addChild(loader);
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function frame(e:Event):void {
      if (!this.fn) {
        return;
      }

      removeEventListener(Event.ENTER_FRAME, frame);
      var self:Object = this;
      for each (var run:Function in [
        function ():void { stage.dispatchEvent(self.relayed); },
        function ():void { self.names.forEach(self.fn); },
        function ():void { self.sorts.sort(self.fn); },
        function ():void { stage.dispatchEvent(new Event("ping")); }
      ]) {
        try {
          run();
        } catch (error:Error) {
          trace("main", error.errorID);
        }
      }
    }
  }
}`,
    ),
    1,
    "EiHandMain",
  );
  const child = bare(
    compile(
      "EiHandChild",
      `package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.external.ExternalInterface;
  public class EiHandChild extends Sprite {
    public function EiHandChild() {
      addEventListener(Event.ADDED_TO_STAGE, added);
    }

    private function added(e:Event):void {
      var main:Object = parent.parent;
      stage.addEventListener("relay", ExternalInterface.call);
      stage.addEventListener("ping", ExternalInterface.call);
      main.relayed = new EiRelay();
      main.names = ["hello"];
      main.sorts = ["hello", "there"];
      main.fn = ExternalInterface.call;
    }
  }
}

import flash.events.Event;

class EiRelay extends Event {
  public function EiRelay() {
    super("relay");
  }

  override public function toString():String {
    return "hello";
  }
}`,
    ),
    1,
    "EiHandChild",
  );
  return { main, child };
}

test("a child's ExternalInterface.call that the main runs through the player is not the main's", {
  skip,
}, async () => {
  const compile = compiler(out);
  const { main, child } = handOver(compile, "http://other.test/child.swf");
  const result = await play(main, { "http://other.test/child.swf": child }, 8);
  // None reaches the page: forEach and sort throw in the main's code, and
  // the two listeners' errors are reported, as a listener's are, not thrown.
  assert.deepEqual(result.evaluated, []);
  assert.deepEqual(result.lines, ["main 2067", "main 2067"]);
  assert.deepEqual(result.uncaught, ["Error: Error #2067", "Error: Error #2067"]);
});

test("the same hand-overs pass where every SWF loaded is the page's own", { skip }, async () => {
  const compile = compiler(out);
  const { main, child } = handOver(compile, "http://page.test/child.swf");
  const result = await play(main, { "http://page.test/child.swf": child }, 8);
  assert.equal(result.lines.filter((l) => l === "main 2067").length, 0);
  // The relay, forEach's one, sort's at least one, and the ping.
  assert.ok(result.evaluated.length >= 4, `${result.evaluated.length} calls reached the page`);
});

test("the main SWF's own calls are its own, a cross-origin child loaded beside it", {
  skip,
}, async () => {
  const compile = compiler(out);
  const main = bare(
    compile(
      "EiMainCalls",
      `package {
  import flash.display.Loader;
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.external.ExternalInterface;
  import flash.net.URLLoader;
  import flash.net.URLLoaderDataFormat;
  import flash.net.URLRequest;
  import flash.system.fscommand;
  public class EiMainCalls extends MovieClip {
    private var ran:Boolean = false;

    public function EiMainCalls() {
      var loader:Loader = new Loader();
      loader.load(new URLRequest("http://other.test/child.swf"));
      addChild(loader);
      // Bytes it loads itself: the content is the main SWF's.
      var stream:URLLoader = new URLLoader();
      stream.dataFormat = URLLoaderDataFormat.BINARY;
      stream.addEventListener(Event.COMPLETE, function (e:Event):void {
        new Loader().loadBytes(stream.data);
      });
      stream.load(new URLRequest("http://page.test/own.swf"));
      addFrameScript(2, frameScript);
      addEventListener(Event.ENTER_FRAME, enterFrame);
    }

    private function frameScript():void {
      ExternalInterface.call("hello", "frame script");
      fscommand("frame script", "");
      stop();
    }

    private function enterFrame(e:Event):void {
      if (currentFrame == 3 && !ran) {
        ran = true;
        ExternalInterface.call("hello", "enterFrame");
        fscommand("enterFrame", "");
      }
    }
  }
}`,
    ),
    4,
    "EiMainCalls",
  );
  const child = bare(
    compile("EiRanChild", sprite("EiRanChild", `trace("child ran");`)),
    1,
    "EiRanChild",
  );
  const own = bare(
    compile("EiOwnBytes", sprite("EiOwnBytes", `trace("bytes", loaderInfo.loaderURL);`)),
    1,
    "EiOwnBytes",
  );
  const result = await play(
    main,
    { "http://other.test/child.swf": child, "http://page.test/own.swf": own },
    6,
  );

  assert.deepEqual(result.lines, ["bytes http://page.test/main.swf", "child ran"]);
  assert.deepEqual(result.uncaught, []);
  // Through playerglobal's call: declined to evalJS here, it is offered there first.
  assert.deepEqual(
    result.evaluated.map((source) => /hello\("([^"]+)"\)/.exec(source)?.[1]),
    ["enterFrame", "frame script"],
  );
  // fscommand, a global function called by its name: the main's, not every SWF's.
  assert.deepEqual(result.commands, [
    { command: "enterFrame", callers: ["http://page.test/main.swf"] },
    { command: "frame script", callers: ["http://page.test/main.swf"] },
  ]);
});
