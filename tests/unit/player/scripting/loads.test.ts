// What a SWF's scripts load, through the host, and when it comes: a
// Loader's SWF from a URL or from bytes, AS3 or AVM1, its LoaderInfo's
// events and parameters, and a URLRequest as the host's fetch receives it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
import { containerEngine } from "../../../../oracle/oracle.ts";
import type { Container, MovieClip } from "../../../../packages/player/dist/display/display.js";
import type { FetchRequest } from "../../../../packages/player/dist/hosts.js";
import { pointerTarget } from "../../../../packages/player/dist/input/pointer.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare, innerSwf } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";
import * as w from "../../../swf-writer.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../out/player-loads/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("an unloaded LoaderInfo reports its owner's URL before any load", { skip }, async () => {
  const scripting = new Scripting(await createCodegen(wasm), {
    print: () => {},
    url: "http://example.test/outer.swf",
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const rt = scripting.rt;
  const loader = rt.construct(rt.classNamed("flash.display::Loader"));
  const info = rt.getProperty(loader, rt.publicName("contentLoaderInfo"));

  assert.equal(rt.getProperty(info, rt.publicName("url")), null);
  assert.equal(rt.getProperty(info, rt.publicName("loaderURL")), "http://example.test/outer.swf");
});

test("loaderInfo.parameters: the main SWF's query and flashvars, a loaded SWF's query or context's", {
  skip,
}, async () => {
  const lines: string[] = [];
  const compile = compiler(out);
  const inner = bare(compile("ParametersInner"), 1, "ParametersInner");
  const fetches: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    url: "http://example.test/main.swf?q=1&shared=query&x=a+b#shared=fragment",
    parameters: { shared: "flashvars", f: "v w" },
    fetch: async ({ url }) => {
      fetches.push(url);
      return { bytes: inner, status: 200, headers: [] };
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compile("FlashVars"), 2, "FlashVars"), scripting);
  await player.start();

  // The flashvars override the query's names, as Ruffle's; the stage's and
  // the root's are the main SWF's. A context's parameters are told from
  // the call on.
  const main = "{f=v w,q=1,shared=flashvars,x=a b}";
  assert.deepEqual(lines.splice(0), [
    `main ${main} ${main} ${main}`,
    "query after {}",
    "given after {g=ctx}",
  ]);
  assert.deepEqual(fetches, [
    "http://example.test/inner.swf?k=1&k=2&t&=v&w=x=y+z&s=%E2%82%AC#k=3",
    "http://example.test/inner.swf?k=1",
  ]);

  // A URL's query comes with the SWF, at the second PROGRESS, as Flash's
  // (decoded, the last of a name kept, an empty name left out); the
  // context's parameters take its place. The contents' constructors see
  // the same, before the frame's script.
  await scripting.settled();
  player.tick();
  const query = "{k=2,s=€,t=,w=x=y z}";
  assert.deepEqual(lines.splice(0), [
    "query open {}",
    "query progress {}",
    `query progress ${query}`,
    "given open {g=ctx}",
    "given progress {g=ctx}",
    "given progress {g=ctx}",
    `loaded ${query.slice(1, -1)} ${query}`,
    "loaded g=ctx {g=ctx}",
    `query init ${query}`,
    "given init {g=ctx}",
  ]);
});

test("a Loader's load of a URL fetches through the host, and fails as one, in frames", {
  skip,
}, async () => {
  const lines: string[] = [];
  const codegen = await createCodegen(wasm);
  const compile = compiler(out);
  const inner = innerSwf(compile("Inner"));
  const nested = bare(compile("LoadsNested"), 2, "LoadsNested");
  const replacer = bare(compile("Replacer"), 1, "Replacer");
  const fetches: string[] = [];
  const aborted: string[] = [];
  const scripting = new Scripting(codegen, {
    print: (line) => lines.push(line),
    url: "http://example.test/outer.swf",
    fetch: async ({ url }, signal) => {
      fetches.push(url);
      signal.addEventListener("abort", () => aborted.push(url));
      if (url.endsWith("inner.swf") || url.endsWith("deep.swf")) {
        return { bytes: inner, status: 200, headers: [] };
      }

      if (url.endsWith("nested.swf")) {
        return { bytes: nested, status: 200, headers: [] };
      }

      if (url.endsWith("replacer.swf")) {
        return { bytes: replacer, status: 200, headers: [] };
      }

      throw new Error("404");
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compile("LoadsUrl"), 6), scripting);
  await player.start();
  // The frame that asks sees nothing of the loads; the host is asked for the URLs resolved against the SWF's.
  assert.deepEqual(lines.splice(0), ["0 requested inner.swf", "1 requested missing.swf"]);
  assert.deepEqual(fetches, ["http://example.test/inner.swf", "http://example.test/missing.swf"]);

  // The next frame: the bytes that came are told as a URL load tells them,
  // OPEN and the progress, then the content comes as from loadBytes (the
  // loads case has Flash's trace of that); the fetch that failed is an
  // IO_ERROR worded as Flash's, in the order asked; the frame's scripts
  // follow, the content's first after its parent's; INIT and COMPLETE end
  // the frame.
  await scripting.settled();
  player.tick();
  const content = [
    "Inner made false false true true 1 true",
    "Inner added true false false false false true",
    "Inner added true false false true true true",
    "Inner addedToStage true true true true true true",
  ];
  assert.deepEqual(lines.splice(0), [
    "0 open - null false",
    `0 progress 0/${inner.length} null false`,
    `0 progress ${inner.length}/${inner.length} null false`,
    ...content,
    "1 ioError Error #2035: URL Not Found. URL: http://example.test/missing.swf null false",
    "2 requested inner.swf",
    "3 requested nested.swf",
    "4 requested inner.swf",
    "5 requested missing.swf",
    "inner frame 1 true true true true",
    "0 init - http://example.test/inner.swf true",
    "0 complete - http://example.test/inner.swf true",
  ]);
  // Closing a load and replacing one abort their fetches at once.
  assert.deepEqual(aborted, ["http://example.test/inner.swf", "http://example.test/missing.swf"]);
  const contentOf = (loader: number) => (player.root.children[loader] as Container).children[0];
  const first = contentOf(0);

  // The same SWF again, into a child domain of its own, as a Loader without
  // a context loads: its classes are its own, not the first load's, and it
  // plays on its own.
  // The closed load and the replaced one come to nothing; the replacement
  // loads. A loaded SWF's own load resolves against it.
  await scripting.settled();
  player.tick();
  assert.deepEqual(lines.splice(0), [
    "2 open - null false",
    `2 progress 0/${inner.length} null false`,
    `2 progress ${inner.length}/${inner.length} null false`,
    ...content,
    `3 open - null false`,
    `3 progress 0/${nested.length} null false`,
    `3 progress ${nested.length}/${nested.length} null false`,
    "5 open - null false",
    `5 progress 0/${inner.length} null false`,
    `5 progress ${inner.length}/${inner.length} null false`,
    ...content,
    "frame 3 1,0,1,1,0,1",
    `before reload true ${inner.length} 10`,
    "after reload true 0 0 true true",
    "6 requested inner.swf",
    "7 requested inner.swf",
    "inner frame 2",
    "inner frame 1 true true true true",
    "nested requested deep.swf",
    "inner frame 1 true true true true",
    "2 init - http://example.test/inner.swf true",
    "2 complete - http://example.test/inner.swf true",
    "3 init - http://example.test/nested.swf true",
    "3 complete - http://example.test/nested.swf true",
    "5 init - http://example.test/inner.swf true",
    "5 complete - http://example.test/inner.swf true",
  ]);
  assert.equal(fetches[fetches.length - 1], "http://example.test/deep.swf");
  const second = contentOf(2);
  assert.ok(first.object && second.object);
  assert.notEqual(first.object, second.object);
  assert.notEqual(Object.getPrototypeOf(second.object), Object.getPrototypeOf(first.object));

  // The reload: the first Loader's content went at the call, and the new
  // content comes as a first load's does; the one unloaded before its bytes
  // came stays empty. The nested SWF's content reports the nested SWF as its
  // loaderURL (the last field of addedToStage). The loaded clips' scripts
  // run in tree order, the reloaded one's first again.
  await scripting.settled();
  player.tick();
  assert.deepEqual(lines.splice(0), [
    "0 open - null false",
    `0 progress 0/${inner.length} null false`,
    `0 progress ${inner.length}/${inner.length} null false`,
    ...content,
    // A load replaced from its OPEN listener ends there: no progress, no content.
    "7 open - null false",
    "replaced from open true 0",
    ...content,
    // Loader 0's first content, let go of by the reload, plays on as an orphan: its scripts first.
    "inner frame 1 false true true false",
    "frame 4 1,0,1,1,0,1,0,0 1",
    // An unload asked for again from REMOVED finds no content: one REMOVED; this one stops the content.
    "unloaded from removed 1 0 true",
    "8 requested replacer.swf",
    "inner frame 1 true true true true",
    "inner frame 2",
    "inner frame 1 true true true true",
    "inner frame 2",
    "0 init - http://example.test/inner.swf true",
    "0 complete - http://example.test/inner.swf true",
  ]);
  assert.deepEqual(aborted.slice(2), ["http://example.test/inner.swf"]);

  // The replacement asked for from OPEN loads as any, and the replaced never
  // attached; the nested SWF's two frames loop, so it asks for its load again.
  await scripting.settled();
  player.tick();
  assert.deepEqual(lines.splice(0), [
    "7 open - null false",
    `7 progress 0/${nested.length} null false`,
    `7 progress ${nested.length}/${nested.length} null false`,
    // Content that replaces its own load from its constructor never attaches, and its scripts never run.
    "8 open - null false",
    `8 progress 0/${replacer.length} null false`,
    `8 progress ${replacer.length}/${replacer.length} null false`,
    "replaced from constructor true 0",
    // Loader 0's orphan plays on; loader 2's, stopped, is silent.
    "inner frame 2",
    "frame 5 1,0,0,1,0,1,0,1,0 LoadsNested",
    // From bytes, closing from the first PROGRESS: no second, no content.
    `9 progress 0/${inner.length}`,
    // The content replaced loads another from REMOVED; the replacement that asked is dropped for it.
    "loaded from removed",
    "inner frame 2",
    "nested requested deep.swf",
    "inner frame 2",
    // The replaced content, off the display list, still runs the script it had queued.
    "inner frame 1 false true true false",
    "nested requested deep.swf",
    "7 init - http://example.test/nested.swf true",
    "7 complete - http://example.test/nested.swf true",
  ]);

  // The load the constructor asked for instead comes as any, and with it
  // the loads the two nested SWFs asked for in frame 5, in the order asked.
  await scripting.settled();
  player.tick();
  assert.deepEqual(lines.splice(0), [
    "8 open - null false",
    `8 progress 0/${inner.length} null false`,
    `8 progress ${inner.length}/${inner.length} null false`,
    ...content,
    // The load asked for from REMOVED, the nested SWF, is loader 5's; the one that replaced it is not.
    "5 open - null false",
    `5 progress 0/${nested.length} null false`,
    `5 progress ${nested.length}/${nested.length} null false`,
    ...content,
    ...content,
    // The orphans, newest first: loader 5's replaced content, then loader 0's.
    "inner frame 2",
    "inner frame 1 false true true false",
    "frame 6 1,0,0,1,0,1,0,1,1,0 Inner LoadsNested",
    "inner frame 1 true true true true",
    "inner frame 1 true true true true",
    "inner frame 1 true true true true",
    "nested requested deep.swf",
    "inner frame 1 true true true true",
    "inner frame 1 true true true true",
    "8 init - http://example.test/inner.swf true",
    "8 complete - http://example.test/inner.swf true",
    "5 init - http://example.test/nested.swf true",
    "5 complete - http://example.test/nested.swf true",
  ]);
});

test("a loaded SWF's class is bound to its symbol as soon as a script can find it", {
  skip,
}, async () => {
  const lines: string[] = [];
  const compile = compiler(out);
  // A class bound to a sprite of three frames, in a SWF loaded into its
  // loader's own domain, as an application loads its parts into one
  // domain; and its loader.
  const shared = compile(
    "BoundFrames",
    `package {
  import flash.display.MovieClip;
  public class BoundFrames extends MovieClip {
    public function BoundFrames() { trace("loaded"); }
  }
  public class Frames extends MovieClip {}
}`,
  );
  const loads = compile(
    "LoadsShared",
    `package {
  import flash.display.Loader;
  import flash.display.MovieClip;
  import flash.net.URLRequest;
  import flash.system.ApplicationDomain;
  import flash.system.LoaderContext;
  public class LoadsShared extends MovieClip {
    public function LoadsShared() {
      new Loader().load(new URLRequest("frames.swf"), new LoaderContext(false, ApplicationDomain.currentDomain));
    }
  }
}`,
  );
  const frames = w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.sprite(1, 3, [w.showFrame(), w.showFrame(), w.showFrame(), w.end()]),
      w.doAbc(shared, "BoundFrames"),
      w.symbolClass([
        [0, "BoundFrames"],
        [1, "Frames"],
      ]),
      w.showFrame(),
      w.end(),
    ],
  });
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    url: "http://example.test/outer.swf",
    fetch: async () => ({ bytes: frames, status: 200, headers: [] }),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(loads, 2, "LoadsShared"), scripting);
  await player.start();

  // Linked, its frame not yet come, as its document class has not traced:
  // the class found then, as another SWF's load completing would find it,
  // makes the symbol's clip, all its frames, not an empty one.
  await scripting.settled();
  const cls = scripting.rt.classNamed("Frames", scripting.mainDomain);
  const made = scripting.rt.constructClass(cls, []) as avm2.AsObject;
  assert.equal((made.$display as MovieClip).totalFrames, 3);
  assert.deepEqual(lines, []);
});

test("a stalled URLStream does not hold up a later Loader load", { skip }, async () => {
  const compile = compiler(out);
  const inner = innerSwf(compile("Inner"));
  const scripting = new Scripting(await createCodegen(wasm), {
    print: () => {},
    url: "http://example.test/outer.swf",
    fetch: ({ url }) =>
      url.endsWith("never.bin")
        ? new Promise(() => {})
        : Promise.resolve({ bytes: inner, status: 200, headers: [] }),
  });
  assert.equal(
    scripting.loads.streamError("missing.bin"),
    "Error #2032: Stream Error. URL: http://example.test/missing.bin",
  );
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const root = compile(
    "StreamLoaderRoot",
    "package { import flash.display.Sprite; public class StreamLoaderRoot extends Sprite {} }",
  );
  const player = new Player(bare(root, 1, "StreamLoaderRoot"), scripting);
  await player.start();

  scripting.loads.requestBytes("never.bin", new AbortController().signal, () => {});
  const loader = scripting.rt.construct(
    scripting.rt.classNamed("flash.display::Loader"),
  ) as avm2.AsObject;
  scripting.loads.requestLoadUrl(loader, "inner.swf");
  // settled() waits for both requests, but Loader's preparation must finish
  // independently of the stream that never resolves.
  const preparing = (scripting.loads as unknown as { preparing: Promise<void> }).preparing;
  const finished = await Promise.race([
    preparing.then(() => true),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), 3000).unref();
    }),
  ]);
  assert.equal(finished, true);

  player.tick();
  assert.ok(loader.$content);
});

test("URLRequest data reaches the host as a query or a copied body", { skip }, async () => {
  const requests: FetchRequest[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: () => {},
    url: "http://example.test/outer.swf",
    fetch: async (request) => {
      requests.push(request);
      return { bytes: new Uint8Array(0), status: 200, headers: [] };
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const rt = scripting.rt;
  const name = (property: string) => rt.publicName(property);
  const load = (request: avm2.AsObject) =>
    scripting.loads.requestBytes(request, new AbortController().signal, () => {});
  const cls = rt.classNamed("flash.net::URLRequest");

  const get = rt.construct(cls, "/api?old=1#part") as avm2.AsObject;
  rt.setProperty(get, name("data"), "new=2");
  load(get);
  assert.deepEqual(requests[0], {
    url: "http://example.test/api?old=1&new=2#part",
    method: "GET",
    headers: [],
    body: null,
  });

  const variables = rt.construct(rt.classNamed("flash.net::URLVariables"), "sku=Test");
  rt.setProperty(get, name("data"), variables);
  load(get);
  assert.equal(requests[1].url, "http://example.test/api?old=1&sku=Test#part");

  const post = rt.construct(cls, "/api") as avm2.AsObject;
  rt.setProperty(post, name("method"), "POST");
  rt.setProperty(post, name("contentType"), "text/plain");
  rt.setProperty(post, name("data"), "hello");
  const header = rt.construct(rt.classNamed("flash.net::URLRequestHeader"), "X-Test", "one");
  rt.setProperty(post, name("requestHeaders"), rt.array([header]));
  load(post);
  assert.deepEqual(requests[2], {
    url: "http://example.test/api",
    method: "POST",
    headers: [
      ["X-Test", "one"],
      ["Content-Type", "text/plain"],
    ],
    body: new TextEncoder().encode("hello"),
  });

  const binary = rt.construct(rt.classNamed("flash.utils::ByteArray")) as avm2.AsObject;
  const bytes = avm2.bytesOf(rt, binary);
  bytes.write(new Uint8Array([0, 255, 4]));
  rt.setProperty(post, name("data"), binary);
  load(post);
  bytes.buffer[0] = 9;
  assert.deepEqual(requests[3].body, new Uint8Array([0, 255, 4]));

  const loader = rt.construct(rt.classNamed("flash.display::Loader"));
  rt.callProperty(loader, name("load"), post);
  assert.equal(requests[4].method, "POST");
  assert.deepEqual(requests[4].body, new Uint8Array([9, 255, 4]));

  rt.setProperty(get, name("requestHeaders"), rt.array([header]));
  load(get);
  assert.deepEqual(requests[5].headers, []);

  await scripting.settled();
});

test("LoaderInfo reports HTTP status between init and complete, and before an I/O error", {
  skip,
}, async () => {
  const compile = compiler(out);
  const inner = innerSwf(compile("Inner"));
  const scripting = new Scripting(await createCodegen(wasm), {
    print: () => {},
    url: "http://example.test/outer.swf",
    fetch: async ({ url }) =>
      url.endsWith("inner.swf")
        ? { bytes: inner, status: 200, headers: [] }
        : { bytes: null, status: 404, headers: [] },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  assert.equal(
    scripting.rt.toString(scripting.httpStatus(200)),
    '[HTTPStatusEvent type="httpStatus" bubbles=false cancelable=false eventPhase=2 status=200 redirected=false responseURL=null]',
  );
  const statusEvent = scripting.httpStatus(200);
  const responseURL = scripting.rt.publicName("responseURL");
  scripting.rt.setProperty(statusEvent, responseURL, "http://example.test/inner.swf");
  assert.equal(scripting.rt.getProperty(statusEvent, responseURL), "http://example.test/inner.swf");
  const root = compile(
    "StreamLoaderRoot",
    "package { import flash.display.Sprite; public class StreamLoaderRoot extends Sprite {} }",
  );
  const player = new Player(bare(root, 1, "StreamLoaderRoot"), scripting);
  await player.start();

  const loader = scripting.rt.construct(
    scripting.rt.classNamed("flash.display::Loader"),
  ) as avm2.AsObject;
  scripting.loads.requestLoadUrl(loader, "inner.swf");
  const events: string[] = [];
  const info = loader.$loaderInfo as avm2.AsObject;
  info.$listeners = new Map(
    ["open", "progress", "init", "httpStatus", "complete", "ioError"].map((type) => [
      type,
      [
        {
          fn: {
            $f: (event: avm2.AsObject) => {
              events.push(
                type === "httpStatus"
                  ? `${type}:${scripting.rt.getProperty(event, scripting.rt.publicName("status"))}`
                  : type,
              );
            },
          },
          capture: false,
          priority: 0,
        },
      ],
    ]),
  );

  await scripting.settled();
  player.tick();
  assert.deepEqual(events.splice(0), [
    "open",
    "progress",
    "progress",
    "init",
    "httpStatus:200",
    "complete",
  ]);

  scripting.loads.requestLoadUrl(loader, "missing.swf");
  await scripting.settled();
  player.tick();
  assert.deepEqual(events, ["httpStatus:404", "ioError"]);
});

// An AVM1 SWF of version 8: a 10 by 10 square, two frames, and `extra` tags before them.
function avm1Swf(extra: Uint8Array[] = []): Uint8Array {
  const square = w.shape({
    id: 1,
    bounds: [0, 200, 0, 200],
    fills: [0xff0000],
    paths: [
      {
        fill1: 1,
        commands: [
          { move: [0, 0] },
          { line: [200, 0] },
          { line: [200, 200] },
          { line: [0, 200] },
          { line: [0, 0] },
        ],
      },
    ],
  });
  return w.swf({
    version: 8,
    width: 30,
    height: 20,
    frameRate: 12,
    frameCount: 2,
    tags: [
      ...extra,
      square,
      w.place({ depth: 1, character: 1 }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** A player of a bare AS3 root and a Loader on it, whose LoaderInfo's events are logged. */
async function avm1Loading(options: ConstructorParameters<typeof Scripting>[1] = {}) {
  const compile = compiler(out);
  const scripting = new Scripting(await createCodegen(wasm), {
    print: () => {},
    url: "http://example.test/outer.swf",
    ...options,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const root = compile(
    "Avm1Root",
    "package { import flash.display.Sprite; public class Avm1Root extends Sprite {} }",
  );
  const player = new Player(bare(root, 1, "Avm1Root"), scripting);
  await player.start();

  const rt = scripting.rt;
  const loader = rt.construct(rt.classNamed("flash.display::Loader")) as avm2.AsObject;
  rt.callProperty(player.root.object, rt.publicName("addChild"), loader);
  const info = rt.getProperty(loader, rt.publicName("contentLoaderInfo")) as avm2.AsObject;
  const events: string[] = [];
  info.$listeners = new Map(
    ["open", "progress", "init", "httpStatus", "complete", "ioError"].map((type) => [
      type,
      [
        {
          fn: {
            $f: (event: avm2.AsObject) => {
              const text = type === "ioError" ? rt.getProperty(event, rt.publicName("text")) : "";
              events.push(text ? `${type} ${text}` : type);
            },
          },
          capture: false,
          priority: 0,
        },
      ],
    ]),
  );
  const content = () => rt.getProperty(loader, rt.publicName("content")) as avm2.AsObject | null;
  const get = (name: string) => rt.getProperty(info, rt.publicName(name));
  const parameter = (name: string) =>
    rt.getProperty(get("parameters") as avm2.AsObject, rt.publicName(name));
  return { scripting, player, rt, loader, info, events, content, get, parameter };
}

test("an AVM1 SWF from a URL comes as an AS3 one's content does, its INIT and COMPLETE at the frame's end", {
  skip,
}, async () => {
  const avm1 = avm1Swf();
  const { scripting, player, rt, loader, events, content, get, parameter } = await avm1Loading({
    fetch: async () => ({ bytes: avm1, status: 200, headers: [] }),
  });
  scripting.loads.requestLoadUrl(loader, "avm1.swf?a=1");

  await scripting.settled();
  player.tick();
  assert.deepEqual(events, ["open", "progress", "progress", "init", "httpStatus", "complete"]);
  const movie = content() as avm2.AsObject;
  assert.equal(rt.traitsOf(movie).name, "flash.display::AVM1Movie");
  assert.deepEqual(
    ["actionScriptVersion", "swfVersion", "frameRate", "width", "height"].map(get),
    [2, 8, 12, 30, 20],
  );
  assert.equal(parameter("a"), "1");

  // Added in the frame's construct phase, as an AS3 SWF's root is (Ruffle),
  // it plays on from the next frame.
  const clip = movie.$display as MovieClip;
  assert.equal(clip.children.length, 1);
  const frames = [clip.currentFrame];
  for (let i = 0; i < 3; i++) {
    player.tick();
    frames.push(clip.currentFrame);
  }

  assert.deepEqual(frames, [1, 2, 1, 2]);
});

test("an AVM1 SWF from bytes comes at the end of the frame, its context's parameters on it", {
  skip,
}, async () => {
  const { scripting, player, rt, loader, events, content, parameter } = await avm1Loading();
  scripting.loads.requestLoad(loader, avm1Swf(), undefined, new Map([["b", "2"]]));
  assert.deepEqual(events.splice(0), ["progress", "progress"]);
  assert.equal(content(), null);

  // Made in the call, a frame's end away: no settling needed.
  player.tick();
  assert.deepEqual(events, ["init", "complete"]);
  const movie = content() as avm2.AsObject;
  assert.equal(rt.traitsOf(movie).name, "flash.display::AVM1Movie");
  assert.equal(parameter("b"), "2");
  const clip = movie.$display as MovieClip;
  const frames = [clip.currentFrame];
  for (let i = 0; i < 3; i++) {
    player.tick();
    frames.push(clip.currentFrame);
  }

  assert.deepEqual(frames, [1, 1, 2, 1]);
});

test("an AVM1 SWF from bytes with an image comes once it is decoded, or ends in #2124", {
  skip,
}, async () => {
  // DefineBitsJPEG2 holding a PNG's signature, which the decoders below take as an image.
  const png = w.tag(
    21,
    Uint8Array.from([2, 0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    true,
  );
  const decoded = await avm1Loading({
    decodeImage: async () => ({ width: 1, height: 1, rgba: Uint8Array.from([0, 0, 255, 255]) }),
  });
  decoded.scripting.loads.requestLoad(decoded.loader, avm1Swf([png]));
  decoded.events.splice(0);
  decoded.player.tick();
  assert.deepEqual(decoded.events, []);
  await decoded.scripting.settled();
  decoded.player.tick();
  assert.deepEqual(decoded.events, ["init", "complete"]);
  assert.ok(decoded.content());

  const refused = await avm1Loading({ decodeImage: () => Promise.reject(new Error("no")) });
  refused.scripting.loads.requestLoad(refused.loader, avm1Swf([png]));
  refused.events.splice(0);
  await refused.scripting.settled();
  refused.player.tick();
  assert.deepEqual(refused.events, ["ioError Error #2124: Loaded file is an unknown type."]);
  assert.equal(refused.content(), null);
});

test("an AVM1 SWF from bytes closed or unloaded before the frame's end never comes", {
  skip,
}, async () => {
  const { scripting, player, rt, loader, events, content } = await avm1Loading();
  scripting.loads.requestLoad(loader, avm1Swf());
  rt.callProperty(loader, rt.publicName("close"));
  scripting.loads.requestLoad(loader, avm1Swf());
  rt.callProperty(loader, rt.publicName("unload"));
  events.splice(0);
  player.tick();
  assert.deepEqual(events, []);
  assert.equal(content(), null);
  assert.equal((loader.$display as Container).children.length, 0);
});

test("the pointer over an AVM1 movie hits its Loader, the AVM1Movie being no InteractiveObject", {
  skip,
}, async () => {
  const { scripting, player, loader } = await avm1Loading();
  scripting.loads.requestLoad(loader, avm1Swf());
  player.tick();

  assert.equal(pointerTarget(player.stage, 5, 5, player.width, player.height), loader.$display);
  // Off the movie's artwork, the stage.
  assert.equal(pointerTarget(player.stage, 15, 15, player.width, player.height), player.stage);
});
