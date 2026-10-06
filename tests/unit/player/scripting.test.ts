// The player's AS3 half in node, without a renderer: a document class
// compiled in the oracle's container, loaded through the release
// codegen.wasm, constructed on the root with the timeline's children in
// place, its frame scripts run in frame order.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { zlibCompress } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { containerEngine } from "../../../oracle/oracle.ts";
import type { Container, MovieClip } from "../../../packages/player/dist/display/display.js";
import { pointerTarget } from "../../../packages/player/dist/input/pointer.js";
import { Player } from "../../../packages/player/dist/player.js";
import { type FetchRequest, Scripting } from "../../../packages/player/dist/scripting.js";
import { bare, innerSwf, scripted } from "../../player/cases.ts";
import { libraryAbcs } from "../../player/libraries.ts";
import { compiler, compileScripts } from "../../player/scripts.ts";
import * as w from "../../swf-writer.ts";

// This package's own out directory: the player's tests run at the same time and use theirs.
const out = fileURLToPath(new URL("../out/player/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("a document class is constructed on the root and its frame scripts run in order", {
  skip,
}, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const abc = compileScripts(["Main"], out).get("Main") as Uint8Array;
  const player = new Player(scripted(abc), scripting);
  await player.start();

  // Constructed with frame 1's children in place, then frame 1's script.
  assert.deepEqual(lines, ["Main 1 2 1 box 10", "frame 1 1 10"]);
  const root = player.root;
  assert.ok(root.object);
  assert.equal(root.object.$display, root);
  // A main movie's document class is constructed on the stage; a Loader's content is not (see the oracle).
  assert.equal(root.parent, player.stage);
  assert.ok(player.stage.object);
  const box = root.depths.get(1) as MovieClip;
  assert.ok(box.object);
  assert.equal(box.currentFrame, 1);

  player.tick();
  assert.deepEqual(lines.slice(2), ["frame 2 2 50"]);
  // The loop back to frame 1 runs its script again; the box is the same object.
  player.tick();
  assert.deepEqual(lines.slice(3), ["frame 1 1 10"]);
  assert.equal(root.depths.get(1), box);
});

test("Socket uses a host connection and delivers data on player frames", { skip }, async () => {
  const compile = compiler(out);
  const root = compile(
    "SocketHostRoot",
    "package { import flash.display.Sprite; public class SocketHostRoot extends Sprite {} }",
  );
  const sent: Uint8Array[] = [];
  const closeCalls: number[] = [];
  let opened: (() => void) | undefined;
  let received: ((bytes: Uint8Array) => void) | undefined;
  let remoteClose: (() => void) | undefined;
  let failed: ((message: string) => void) | undefined;
  const scripting = new Scripting(await createCodegen(wasm), {
    socket: {
      connect(host, port, events) {
        assert.equal(host, "example.test");
        assert.equal(port, 1234);
        opened = events.open;
        received = events.data;
        remoteClose = events.close;
        failed = events.error;
        return {
          send: (bytes) => sent.push(bytes),
          close: () => closeCalls.push(1),
        };
      },
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(root, 1, "SocketHostRoot"), scripting);
  await player.start();
  const rt = scripting.rt;
  const socket = rt.construct(rt.classNamed("flash.net::Socket")) as avm2.AsObject;
  const events: string[] = [];
  socket.$listeners = new Map(
    ["connect", "socketData", "close", "ioError"].map((type) => [
      type,
      [{ fn: { $f: () => events.push(type) }, capture: false, priority: 0 }],
    ]),
  );
  const call = (name: string, ...args: avm2.Value[]) =>
    rt.callProperty(socket, rt.publicName(name), ...args);
  const get = (name: string) => rt.getProperty(socket, rt.publicName(name));

  assert.equal(get("connected"), false);
  call("connect", "example.test", 1234);
  assert.equal(get("connected"), false);
  opened?.();
  assert.deepEqual(events, []);
  player.tick();
  assert.deepEqual(events, ["connect"]);
  assert.equal(get("connected"), true);

  call("writeByte", 0x12);
  call("writeShort", 0x3456);
  assert.equal(get("bytesPending"), 3);
  call("flush");
  assert.deepEqual(
    sent.map((bytes) => [...bytes]),
    [[0x12, 0x34, 0x56]],
  );
  assert.equal(get("bytesPending"), 0);

  received?.(Uint8Array.from([0x41, 0x42]));
  assert.equal(get("bytesAvailable"), 0);
  player.tick();
  assert.deepEqual(events, ["connect", "socketData"]);
  assert.equal(get("bytesAvailable"), 2);
  assert.equal(call("readUnsignedByte"), 0x41);
  assert.equal(call("readUnsignedByte"), 0x42);

  call("close");
  assert.equal(get("connected"), false);
  assert.equal(closeCalls.length, 1);
  remoteClose?.();
  player.tick();
  assert.deepEqual(events, ["connect", "socketData"]);

  call("connect", "example.test", 1234);
  opened?.();
  player.tick();
  remoteClose?.();
  player.tick();
  assert.deepEqual(events, ["connect", "socketData", "connect", "close"]);
  assert.equal(get("connected"), false);
  assert.equal(closeCalls.length, 1);

  call("connect", "example.test", 1234);
  failed?.("Error #2031: Socket Error.");
  player.tick();
  assert.deepEqual(events, ["connect", "socketData", "connect", "close", "ioError"]);
  assert.equal(closeCalls.length, 2);
  remoteClose?.();
  player.tick();
  assert.equal(events.length, 5);
});

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

test("Mouse.hide and show set the host's cursor as a script calls them", { skip }, async () => {
  const lines: string[] = [];
  const compile = compiler(out);
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compile("MouseVisibility"), 1, "MouseVisibility"), scripting);
  assert.ok(player.pointer);
  player.pointer.onCursor = (cursor) => lines.push(`cursor ${cursor}`);
  await player.start();

  // At once, between the script's own lines, and only when it changes.
  assert.deepEqual(lines, [
    "cursor none",
    "hidden",
    "hidden twice",
    "cursor default",
    "shown",
    "shown twice",
  ]);
});

test("Mouse.cursor and registered cursors set the host's cursor as a script sets them", {
  skip,
}, async () => {
  const lines: string[] = [];
  const compile = compiler(out);
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(
    bare(compile("MouseCursorNatives"), 1, "MouseCursorNatives"),
    scripting,
  );
  assert.ok(player.pointer);
  player.pointer.onCursor = (cursor) => lines.push(`cursor ${describeCursor(cursor)}`);
  await player.start();

  // The refusals and MouseCursorData's own lines are the Flash case's; these show the host's
  // cursor changing at once, only when it changes, and Mouse.hide winning over a forced one.
  const shown = lines.filter((line) => !/threw|^(supports|data|hotSpot|frameRate)/.test(line));
  assert.deepEqual(shown, [
    "cursor auto",
    "cursor = arrow: arrow",
    "cursor pointer",
    "cursor = button: button",
    "cursor grab",
    "cursor = hand: hand",
    "cursor text",
    "cursor = ibeam: ibeam",
    "cursor default",
    "cursor = auto: auto",
    "cursor text",
    "cursor ibeam",
    "cursor none",
    "hidden, cursor button",
    "cursor pointer",
    "cursor default",
    "register mine: auto",
    // The first frame alone, with its hot spot.
    "cursor image 32x32 at 31,10",
    "cursor = mine: mine",
    "cursor default",
    "cursor image 32x32 at 31,10",
    "register mine again with no data: mine",
    "unregister other: mine",
    "cursor default",
    "unregister mine: auto",
    "cursor image 16x16 at 0,0",
    "cursor default",
    "register arrow: auto",
    "cursor pointer",
    "unregister button, never registered: button",
    "cursor default",
  ]);
});

/** A CSS cursor, its image as its PNG's size and its hot spot, as the host is given it. */
function describeCursor(cursor: string): string {
  const image = /^url\("data:image\/png;base64,([^"]+)"\) (\d+) (\d+), default$/.exec(cursor);
  if (!image) {
    return cursor;
  }

  const png = Buffer.from(image[1], "base64");
  return `image ${png.readUInt32BE(16)}x${png.readUInt32BE(20)} at ${image[2]},${image[3]}`;
}

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
    scripting.streamError("missing.bin"),
    "Error #2032: Stream Error. URL: http://example.test/missing.bin",
  );
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const root = compile(
    "StreamLoaderRoot",
    "package { import flash.display.Sprite; public class StreamLoaderRoot extends Sprite {} }",
  );
  const player = new Player(bare(root, 1, "StreamLoaderRoot"), scripting);
  await player.start();

  scripting.requestBytes("never.bin", new AbortController().signal, () => {});
  const loader = scripting.rt.construct(
    scripting.rt.classNamed("flash.display::Loader"),
  ) as avm2.AsObject;
  scripting.requestLoadUrl(loader, "inner.swf");
  // settled() waits for both requests, but Loader's preparation must finish
  // independently of the stream that never resolves.
  const preparing = (scripting as unknown as { preparing: Promise<void> }).preparing;
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
    scripting.requestBytes(request, new AbortController().signal, () => {});
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
  scripting.requestLoadUrl(loader, "inner.swf");
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

  scripting.requestLoadUrl(loader, "missing.swf");
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
  scripting.requestLoadUrl(loader, "avm1.swf?a=1");

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
  scripting.requestLoad(loader, avm1Swf(), undefined, new Map([["b", "2"]]));
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
  decoded.scripting.requestLoad(decoded.loader, avm1Swf([png]));
  decoded.events.splice(0);
  decoded.player.tick();
  assert.deepEqual(decoded.events, []);
  await decoded.scripting.settled();
  decoded.player.tick();
  assert.deepEqual(decoded.events, ["init", "complete"]);
  assert.ok(decoded.content());

  const refused = await avm1Loading({ decodeImage: () => Promise.reject(new Error("no")) });
  refused.scripting.requestLoad(refused.loader, avm1Swf([png]));
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
  scripting.requestLoad(loader, avm1Swf());
  rt.callProperty(loader, rt.publicName("close"));
  scripting.requestLoad(loader, avm1Swf());
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
  scripting.requestLoad(loader, avm1Swf());
  player.tick();

  assert.equal(pointerTarget(player.stage, 5, 5, player.width, player.height), loader.$display);
  // Off the movie's artwork, the stage.
  assert.equal(pointerTarget(player.stage, 15, 15, player.width, player.height), player.stage);
});

test("timers fire in the order of their times, each at its own time", { skip }, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    // The frame clock: what the timers trace of getTimer is the same on every run.
    realTime: null,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  // A 10 fps root: the clock is at 100 as the constructor starts the timers, at 400 after three ticks.
  const player = new Player(bare(compiler(out)("Timers"), 4), scripting);
  player.frameRate = 10;
  await player.start();
  player.tick();
  player.tick();
  player.tick();
  // Both due at 400: B was scheduled for it first, at 250, and goes first.
  assert.deepEqual(lines, ["A 200", "B 250", "A 300", "B 400", "A 400"]);
});

test("timers due at once fire in the order started, after others around them were stopped", {
  skip,
}, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    // The frame clock: what the timers trace of getTimer is the same on every run.
    realTime: null,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  // Five timers started A to E, three stopped at once: B and C, both due at 300, keep their order.
  const player = new Player(bare(compiler(out)("TimerTies"), 3), scripting);
  player.frameRate = 10;
  await player.start();
  player.tick();
  player.tick();
  assert.deepEqual(lines, ["B 300", "C 300"]);
});

test("an AS3 error tells a host the methods it was thrown in", { skip }, async () => {
  const source = `package {
    import flash.display.MovieClip;
    public class Main extends MovieClip {
      public var nothing:Object = null;
      public function Main() {
        addFrameScript(0, frame1);
      }
      private function frame1():void {
        a();
      }
      private function a():void { b(); }
      private function b():void { c(); }
      private function c():void { d(); }
      private function d():void { e(); }
      private function e():void { reachNothing(); }
      private function reachNothing():void {
        trace(nothing.field);
      }
    }
  }`;
  const errors: unknown[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: () => {},
    onUncaught: (error) => errors.push(error),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compiler(out)("ErrorStack", source)), scripting);
  await player.start();

  assert.equal(errors.length, 1);
  assert.match(scripting.rt.toString(errors[0] as avm2.Value), /1009/);
  const stack = scripting.rt.stackOf(errors[0] as avm2.Value) ?? "";
  // The method that reached null first, and the frame script six calls out, past V8's usual ten frames.
  assert.match(stack.split("\n")[0], /reachNothing/);
  assert.match(stack, /frame1/);
  assert.equal(scripting.rt.stackOf("not an error"), null);
});

test("frame scripts that send their clip to each other's frame end in a stack overflow, not the page's", {
  skip,
}, async () => {
  // In a SWF of version 10 each goto runs a cycle inside the last; Flash nests
  // them till it gives up. The player throws AS3's Error #1023 at its depth.
  const source = `package {
    import flash.display.MovieClip;
    public class Bounce extends MovieClip {
      public function Bounce() {
        addFrameScript(0, function():void { gotoAndStop(2); }, 1, function():void { gotoAndStop(1); });
      }
    }
    public class Main extends MovieClip {}
  }`;
  const swf = w.swf({
    version: 10,
    width: 20,
    height: 20,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.sprite(2, 2, [w.showFrame(), w.showFrame(), w.end()]),
      w.doAbc(compiler(out)("Bounce", source)),
      w.symbolClass([
        [0, "Main"],
        [2, "Bounce"],
      ]),
      w.place({ depth: 1, character: 2 }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
  const scripting = new Scripting(await createCodegen(wasm), { print: () => {} });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, scripting);
  await assert.rejects(player.start(), (e: unknown) => {
    assert.match(scripting.rt.toString(e as avm2.Value), /1023/);
    return true;
  });
});

/** A SWF of `version` whose root places Bound, a clip of `frames` frames bound to the script's class. */
function boundClip(abc: Uint8Array, version: number, frames: number): Uint8Array {
  return w.swf({
    version,
    width: 20,
    height: 20,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.sprite(2, frames, [...Array.from({ length: frames }, () => w.showFrame()), w.end()]),
      w.doAbc(abc),
      w.symbolClass([
        [0, "Main"],
        [2, "Bound"],
      ]),
      w.place({ depth: 1, character: 2, name: "bound" }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

test("a goto plays or stops as it happens, so the landing frame's script has the last word", {
  skip,
}, async () => {
  // adl (`goto-stops`): a deferred gotoAndStop from the clip's own script
  // stops it after the play() that follows, and gotoAndPlay from another
  // clip's script runs the landing frame's stop() inside the goto, so the
  // clip stays.
  const source = `package {
    import flash.display.MovieClip;
    public class Bound extends MovieClip {
      public function Bound() {
        addFrameScript(0, function():void { gotoAndStop(2); play(); },
          2, function():void { stop(); });
      }
    }
    public class Main extends MovieClip {
      public var bound:Bound;
      public function Main() {
        addFrameScript(1, function():void { bound.gotoAndPlay(3); });
      }
    }
  }`;
  const scripting = new Scripting(await createCodegen(wasm), { print: () => {} });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(boundClip(compiler(out)("GotoStops", source), 10, 4), scripting);
  await player.start();
  const bound = (player.root as unknown as Container).children[0] as MovieClip;
  assert.deepEqual([bound.currentFrame, bound.playing], [2, false]);

  player.tick();
  assert.deepEqual([bound.currentFrame, bound.playing], [3, false]);

  player.tick();
  assert.deepEqual([bound.currentFrame, bound.playing], [3, false]);
});

test("an orphan plays for a while, then stops where it is until put back", { skip }, async () => {
  // One held stops too, as the player cannot see what holds it, and carries
  // on when put back; one that listens for ENTER_FRAME, held by it in Flash
  // too, plays on.
  const source = `package {
    import flash.display.MovieClip;
    import flash.events.Event;
    public class Bound extends MovieClip {
      public var runs:int = 0;
      public function Bound() {
        addFrameScript(0, function():void { runs++; }, 1, function():void { runs++; });
      }
    }
    public class Main extends MovieClip {
      public var bound:Bound;
      public var kept:Bound;
      public var listening:Bound;
      public function Main() {
        kept = bound;
        removeChild(bound);
        listening = new Bound();
        listening.addEventListener(Event.ENTER_FRAME, function(e:Event):void {});
      }
    }
  }`;
  const scripting = new Scripting(await createCodegen(wasm), { print: () => {} });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(boundClip(compiler(out)("OrphanAge", source), 10, 2), scripting);
  await player.start();
  const kept = scripting.rt.getProperty(
    player.root.object as avm2.AsObject,
    avm2.qname(avm2.publicNs, "kept"),
  ) as avm2.AsObject;
  const clip = kept.$display as MovieClip;
  // Its own count: the root's loop places a new Bound each time round.
  const runsOf = (o: avm2.AsObject) =>
    scripting.rt.getProperty(o, avm2.qname(avm2.publicNs, "runs")) as number;
  const runs = () => runsOf(kept);
  const listening = scripting.rt.getProperty(
    player.root.object as avm2.AsObject,
    avm2.qname(avm2.publicNs, "listening"),
  ) as avm2.AsObject;
  for (let i = 0; i < 100; i++) {
    player.tick();
  }

  const playing = runs() as number;
  assert.ok(playing > 90, `an orphan held plays on: ${playing} runs`);
  for (let i = 0; i < 100; i++) {
    player.tick();
  }

  const stopped = runs() as number;
  assert.ok(stopped < 130, `it stops after 120 frames: ${stopped} runs`);
  const frame = clip.currentFrame;
  for (let i = 0; i < 10; i++) {
    player.tick();
  }

  assert.deepEqual([runs(), clip.currentFrame], [stopped, frame]);
  // Stopped after its frame's script ran, not between an advance and the script.
  assert.equal(clip.scriptedFrame, clip.currentFrame);
  assert.ok(runsOf(listening) > 200, `one that listens plays on: ${runsOf(listening)} runs`);

  // Put back, it plays on from the frame it stopped on.
  (player.root as unknown as Container).addChildAt(clip, 0);
  scripting.added(clip);
  for (let i = 0; i < 4; i++) {
    player.tick();
  }

  assert.ok((runs() as number) >= stopped + 3, `put back, it plays: ${runs()} runs`);
});

test("a frame script's goto happens though the script throws after it, as in Flash", {
  skip,
}, async () => {
  // adl: the clip goes to frame 3 and runs its script there, the error reported apart.
  const source = `package {
    import flash.display.MovieClip;
    public class Bound extends MovieClip {
      public function Bound() {
        addFrameScript(0, function():void { gotoAndStop(3); throw new Error("after the goto"); },
          2, function():void { trace("script 3"); });
      }
    }
    public class Main extends MovieClip {
      public var bound:Bound;
    }
  }`;
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(boundClip(compiler(out)("GotoThrows", source), 10, 4), scripting);
  await assert.rejects(player.start());
  const bound = (player.root as unknown as Container).children[0] as MovieClip;
  assert.equal(bound.currentFrame, 3);
  assert.deepEqual(lines, ["script 3"]);
});

test("a goto's caller goes on when a script its cycle runs throws, as in Flash", {
  skip,
}, async () => {
  // A goto from a listener, one a frame script queues, and one from another
  // clip's frame script each land on a script that throws. A SWF that loads
  // a level and goes to its first frame from a COMPLETE listener stalled
  // when the goto passed the level's error to it.
  const source = `package {
    import flash.display.MovieClip;
    import flash.events.Event;
    public class Bound extends MovieClip {
      public function Bound() {
        addFrameScript(1, function():void {
          trace("Bound script 2, goto 3");
          gotoAndStop(3);
          trace("Bound after its goto", currentFrame);
        }, 2, function():void {
          trace("Bound script 3 throws");
          throw new Error("from script 3");
        }, 3, function():void {
          trace("Bound script 4 throws");
          throw new Error("from script 4");
        });
      }
    }
    public class Main extends MovieClip {
      public var bound:Bound;
      private var n:int = 0;
      public function Main() {
        addFrameScript(2, function():void {
          try {
            trace("Main script 3, goto 4");
            bound.gotoAndStop(4);
            trace("Main script after goto", bound.currentFrame);
          } catch (error:Error) {
            trace("Main script caught", error.message);
          }
        });
        addEventListener(Event.ENTER_FRAME, enter);
      }
      private function enter(e:Event):void {
        n++;
        if (n == 1) {
          try {
            trace("Main listener, goto 2");
            bound.gotoAndStop(2);
            trace("Main listener after goto", bound.currentFrame);
          } catch (error:Error) {
            trace("Main listener caught", error.message);
          }
        } else if (n == 3) {
          bound.gotoAndStop(1);
          try {
            trace("Main listener, goto 3");
            bound.gotoAndStop(3);
            trace("Main listener after goto", bound.currentFrame);
          } catch (error:Error) {
            trace("Main listener caught", error.message);
          }
          removeEventListener(Event.ENTER_FRAME, enter);
        }
      }
    }
  }`;
  const swf = w.swf({
    version: 10,
    width: 20,
    height: 20,
    frameCount: 5,
    tags: [
      w.fileAttributes(true),
      w.sprite(2, 4, [...Array.from({ length: 4 }, () => w.showFrame()), w.end()]),
      w.doAbc(compiler(out)("GotoCycleThrows", source)),
      w.symbolClass([
        [0, "Main"],
        [2, "Bound"],
      ]),
      w.place({ depth: 1, character: 2, name: "bound" }),
      ...Array.from({ length: 5 }, () => w.showFrame()),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, scripting);
  await player.start();
  const errors: string[] = [];
  for (let frame = 2; frame <= 5; frame++) {
    try {
      player.tick();
    } catch (error) {
      errors.push(scripting.rt.toString(error as avm2.Value));
    }
  }

  // adl's output, the errors reported apart, each when its frame ends.
  assert.deepEqual(lines, [
    "Main listener, goto 2",
    "Bound script 2, goto 3",
    "Bound after its goto 2",
    "Bound script 3 throws",
    "Main listener after goto 3",
    "Main script 3, goto 4",
    "Bound script 4 throws",
    "Main script after goto 4",
    "Main listener, goto 3",
    "Bound script 3 throws",
    "Main listener after goto 3",
  ]);
  assert.deepEqual(errors, [
    "Error: from script 3",
    "Error: from script 4",
    "Error: from script 3",
  ]);
});

test("every error nothing caught is reported, and the listeners and constructors after it run, as in Flash", {
  skip,
}, async () => {
  // Main's first FRAME_CONSTRUCTED and EXIT_FRAME listeners throw, before
  // a second on Main and one on a Sprite off the display list; a listener
  // sends a clip to two frames whose scripts throw; the root's goto to its
  // second frame makes a Bad, whose constructor throws, then a Good.
  const source = `package {
    import flash.display.MovieClip;
    import flash.display.Sprite;
    import flash.events.Event;
    public class Bound extends MovieClip {
      public function Bound() {
        stop();
        addFrameScript(1, function():void { trace("Bound script 2 throws"); throw new Error("from script 2"); },
          2, function():void { trace("Bound script 3 throws"); throw new Error("from script 3"); });
      }
    }
    public class Bad extends MovieClip {
      public function Bad() { trace("making Bad"); throw new Error("from Bad"); }
    }
    public class Good extends MovieClip {
      public function Good() { trace("made Good"); }
    }
    public class Main extends MovieClip {
      public var bound:Bound;
      private var n:int = 0;
      private var other:Sprite = new Sprite();
      public function Main() {
        stop();
        addEventListener(Event.FRAME_CONSTRUCTED, function(_:Event):void {
          if (n == 1) { trace("frameConstructed 1 throws"); throw new Error("from frameConstructed"); }
        });
        addEventListener(Event.FRAME_CONSTRUCTED, function(_:Event):void {
          if (n == 1) trace("frameConstructed 2");
        });
        addEventListener(Event.EXIT_FRAME, function(_:Event):void {
          if (n == 1) { trace("exitFrame 1 throws"); throw new Error("from exitFrame"); }
        });
        addEventListener(Event.EXIT_FRAME, function(_:Event):void {
          if (n == 1) trace("exitFrame 2");
        });
        other.addEventListener(Event.EXIT_FRAME, function(_:Event):void {
          if (n == 1) trace("exitFrame other");
        });
        addEventListener(Event.ENTER_FRAME, enter);
      }
      private function enter(e:Event):void {
        n++;
        if (n == 2) {
          trace("goto 2 and 3");
          bound.gotoAndStop(2);
          bound.gotoAndStop(3);
          trace("after both gotos", bound.currentFrame);
        } else if (n == 3) {
          trace("next frame");
          gotoAndStop(2);
          trace("after root goto", numChildren);
        }
      }
    }
  }`;
  const swf = w.swf({
    version: 10,
    width: 20,
    height: 20,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.sprite(2, 3, [...Array.from({ length: 3 }, () => w.showFrame()), w.end()]),
      w.sprite(3, 1, [w.showFrame(), w.end()]),
      w.sprite(4, 1, [w.showFrame(), w.end()]),
      w.doAbc(compiler(out)("UncaughtErrors", source)),
      w.symbolClass([
        [0, "Main"],
        [2, "Bound"],
        [3, "Bad"],
        [4, "Good"],
      ]),
      w.place({ depth: 1, character: 2, name: "bound" }),
      w.showFrame(),
      w.place({ depth: 2, character: 3 }),
      w.place({ depth: 3, character: 4 }),
      w.showFrame(),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const errors: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    onUncaught: (error) => errors.push(scripting.rt.toString(error as avm2.Value)),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, scripting);
  await player.start();
  for (let frame = 2; frame <= 4; frame++) {
    player.tick();
  }

  // adl's output and the errors it reported, in order.
  assert.deepEqual(lines, [
    "frameConstructed 1 throws",
    "frameConstructed 2",
    "exitFrame 1 throws",
    "exitFrame 2",
    "exitFrame other",
    "goto 2 and 3",
    "Bound script 2 throws",
    "Bound script 3 throws",
    "after both gotos 3",
    "next frame",
    "making Bad",
    "made Good",
    "after root goto 3",
  ]);
  assert.deepEqual(errors, [
    "Error: from frameConstructed",
    "Error: from exitFrame",
    "Error: from script 2",
    "Error: from script 3",
    "Error: from Bad",
  ]);
});

test("without onUncaught, a frame throws all its errors once it has ended", { skip }, async () => {
  // Two gotos from one listener, each landing on a script that throws.
  const source = `package {
    import flash.display.MovieClip;
    import flash.events.Event;
    public class Bound extends MovieClip {
      public function Bound() {
        stop();
        addFrameScript(1, function():void { throw new Error("from script 2"); },
          2, function():void { throw new Error("from script 3"); });
      }
    }
    public class Main extends MovieClip {
      public var bound:Bound;
      public function Main() {
        addEventListener(Event.ENTER_FRAME, function(_:Event):void {
          if (bound.currentFrame == 1) {
            bound.gotoAndStop(2);
            bound.gotoAndStop(3);
          }
        });
        addEventListener(Event.EXIT_FRAME, function(_:Event):void { trace("exitFrame", bound.currentFrame); });
      }
    }
  }`;
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(boundClip(compiler(out)("UncaughtThrown", source), 10, 3), scripting);
  await player.start();
  let thrown: unknown = null;
  try {
    player.tick();
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof AggregateError);
  assert.deepEqual(
    thrown.errors.map((e) => scripting.rt.toString(e as avm2.Value)),
    ["Error: from script 2", "Error: from script 3"],
  );
  // The frame ran to its end, each goto's cycle with its EXIT_FRAME, before
  // it threw; the next has nothing to throw.
  assert.deepEqual(lines, ["exitFrame 1", "exitFrame 2", "exitFrame 3", "exitFrame 3"]);
  player.tick();
});

test("a listener's error never reaches the dispatcher, and the listeners after it run, as in Flash", {
  skip,
}, async () => {
  // Two listeners each to a script's dispatchEvent, a Loader's INIT and a
  // Timer's TIMER, the first of each throwing: dispatchEvent still returns
  // true, COMPLETE still comes, and the timer still stops after two.
  const source = `package {
    import flash.display.Loader;
    import flash.display.MovieClip;
    import flash.events.Event;
    import flash.events.EventDispatcher;
    import flash.events.TimerEvent;
    import flash.system.LoaderContext;
    import flash.utils.ByteArray;
    import flash.utils.Timer;
    public class Main extends MovieClip {
      private var timer:Timer;
      public function Main() {
        var d:EventDispatcher = new EventDispatcher();
        d.addEventListener("x", function(e:Event):void { trace("x1 throws"); throw new Error("from x1"); });
        d.addEventListener("x", function(e:Event):void { trace("x2 ran"); });
        trace("dispatch returned", d.dispatchEvent(new Event("x")));
        // An empty SWF of version 10: header, a zero rectangle, 12 fps, one frame, FileAttributes, ShowFrame, End.
        var swf:ByteArray = new ByteArray();
        for each (var b:int in [0x46, 0x57, 0x53, 10, 23, 0, 0, 0, 0, 0, 12, 1, 0, 0x44, 0x11, 8, 0, 0, 0, 0x40, 0, 0, 0]) {
          swf.writeByte(b);
        }
        var loader:Loader = new Loader();
        loader.contentLoaderInfo.addEventListener(Event.INIT, function(e:Event):void { trace("init1 throws"); throw new Error("from init1"); });
        loader.contentLoaderInfo.addEventListener(Event.INIT, function(e:Event):void { trace("init2"); });
        loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
          trace("complete");
          timer = new Timer(20, 2);
          timer.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void { trace("timer1 throws", timer.currentCount); throw new Error("from timer1"); });
          timer.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void { trace("timer2", timer.currentCount); });
          timer.addEventListener(TimerEvent.TIMER_COMPLETE, function(e:TimerEvent):void { trace("timer complete", timer.running); });
          timer.start();
        });
        var context:LoaderContext = new LoaderContext();
        context.allowCodeImport = true;
        loader.loadBytes(swf, context);
      }
    }
  }`;
  const lines: string[] = [];
  const errors: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    onUncaught: (error) => errors.push(scripting.rt.toString(error as avm2.Value)),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compiler(out)("UncaughtListeners", source), 1), scripting);
  await player.start();
  for (let frame = 2; frame <= 20; frame++) {
    await scripting.settled();
    player.tick();
  }

  // adl's output and the errors it reported, in order.
  assert.deepEqual(lines, [
    "x1 throws",
    "x2 ran",
    "dispatch returned true",
    "init1 throws",
    "init2",
    "complete",
    "timer1 throws 1",
    "timer2 1",
    "timer1 throws 2",
    "timer2 2",
    "timer complete false",
  ]);
  assert.deepEqual(errors, [
    "Error: from x1",
    "Error: from init1",
    "Error: from timer1",
    "Error: from timer1",
  ]);
});

test("a document class's constructor that throws is reported, and its SWF plays on, as in Flash", {
  skip,
}, async () => {
  // The main SWF's document class registers a frame script and a listener,
  // which tries a goto to a scene that does not exist, loads a SWF whose
  // document class throws and then an empty one, and throws itself.
  const compile = compiler(out);
  const inner = innerSwf(
    compile(
      "CtorThrowsInner",
      `package {
        import flash.display.MovieClip;
        public class Inner extends MovieClip {
          public function Inner() { trace("Inner throws"); throw new Error("from Inner"); }
        }
      }`,
    ),
    1,
  );
  const empty = [
    0x46, 0x57, 0x53, 10, 23, 0, 0, 0, 0, 0, 12, 1, 0, 0x44, 0x11, 8, 0, 0, 0, 0x40, 0, 0, 0,
  ];
  const source = `package {
    import flash.display.Loader;
    import flash.display.MovieClip;
    import flash.events.Event;
    import flash.system.LoaderContext;
    import flash.utils.ByteArray;
    public class Main extends MovieClip {
      public function Main() {
        addFrameScript(0, function():void { trace("script 1"); });
        var n:int = 0;
        addEventListener(Event.ENTER_FRAME, function(e:Event):void {
          n++;
          if (n <= 2) trace("enter", n);
          if (n == 1) {
            try { gotoAndStop(1, "noscene"); } catch (e:Error) { trace("caught", e.errorID); }
          }
        });
        load("A", [${Array.from(inner).join(",")}]);
        load("B", [${empty.join(",")}]);
        trace("Main throws");
        throw new Error("from Main");
      }
      private function load(name:String, bytes:Array):void {
        var swf:ByteArray = new ByteArray();
        for each (var b:int in bytes) {
          swf.writeByte(b);
        }
        var loader:Loader = new Loader();
        loader.contentLoaderInfo.addEventListener(Event.INIT, function(e:Event):void { trace("init", name, loader.content != null); });
        loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void { trace("complete", name); });
        var context:LoaderContext = new LoaderContext();
        context.allowCodeImport = true;
        loader.loadBytes(swf, context);
      }
    }
  }`;
  const run = async (hook: boolean) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const scripting: Scripting = new Scripting(await createCodegen(wasm), {
      print: (line) => lines.push(line),
      onUncaught: hook
        ? (error) => errors.push(scripting.rt.toString(error as avm2.Value))
        : undefined,
    });
    await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
    const player = new Player(bare(compile("CtorThrows", source), 1), scripting);
    const thrown = (run: () => void) => {
      try {
        run();
      } catch (error) {
        errors.push(scripting.rt.toString(error as avm2.Value));
      }
    };
    await player.start().catch((error: unknown) => {
      errors.push(scripting.rt.toString(error as avm2.Value));
    });
    for (let frame = 2; frame <= 4; frame++) {
      await scripting.settled();
      thrown(() => player.tick());
    }

    return { lines, errors };
  };

  // adl's output: the first frame's script still runs, before the first
  // ENTER_FRAME; a goto's own error, #2108, still reaches its caller; the
  // load whose document class throws has no INIT or COMPLETE, and the next
  // still comes.
  const lines = [
    "Main throws",
    "script 1",
    "enter 1",
    "caught 2108",
    "Inner throws",
    "init B true",
    "complete B",
    "enter 2",
  ];
  // adl reports Main's error, and prints Inner's as its debugger does.
  const errors = ["Error: from Main", "Error: from Inner"];
  assert.deepEqual(await run(true), { lines, errors });
  // Without the hook, start() throws Main's once the first frame has ended.
  assert.deepEqual(await run(false), { lines, errors });
});

test("an onUncaught that throws stops no listener, and its error comes when the frame ends", {
  skip,
}, async () => {
  const source = `package {
    import flash.display.MovieClip;
    import flash.events.Event;
    public class Main extends MovieClip {
      public function Main() {
        addEventListener(Event.EXIT_FRAME, function(e:Event):void { trace("first throws"); throw new Error("from first"); });
        addEventListener(Event.EXIT_FRAME, function(e:Event):void { trace("second"); });
      }
    }
  }`;
  const lines: string[] = [];
  const reported: unknown[] = [];
  const hookError = new Error("from the hook");
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    onUncaught: (error) => {
      reported.push(error);
      throw hookError;
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compiler(out)("HookThrows", source), 1), scripting);
  await assert.rejects(player.start(), (error) => error === hookError);
  assert.deepEqual(lines, ["first throws", "second"]);
  assert.equal(reported.length, 1);
});

test("scripts that catch the stack overflow of their goto cycles stop soon, not after millions of runs", {
  skip,
}, async () => {
  // Two clips that send each other to the other frame, at once, as a goto on
  // another clip is: each cycle runs inside the last, and each script
  // catches the overflow, which must not set the cycles going again.
  const source = `package {
    import flash.display.MovieClip;
    public class Bound extends MovieClip {
      public static var runs:int = 0;
      public function Bound() {
        addFrameScript(0, swap, 1, swap);
      }
      private function swap():void {
        runs++;
        var peer:MovieClip = MovieClip(parent).getChildByName(name == "a" ? "b" : "a") as MovieClip;
        try {
          peer.gotoAndStop(peer.currentFrame == 1 ? 2 : 1);
        } catch (e:Error) {}
      }
    }
    public class Main extends MovieClip {
      public var a:Bound;
      public var b:Bound;
      public function Main() {
        addEventListener("exitFrame", function(_:*):void { trace("runs", Bound.runs); });
      }
    }
  }`;
  const swf = w.swf({
    version: 10,
    width: 20,
    height: 20,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.sprite(2, 2, [w.showFrame(), w.showFrame(), w.end()]),
      w.doAbc(compiler(out)("CaughtOverflow", source)),
      w.symbolClass([
        [0, "Main"],
        [2, "Bound"],
      ]),
      w.place({ depth: 1, character: 2, name: "a" }),
      w.place({ depth: 2, character: 2, name: "b" }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, scripting);
  await player.start();
  const runs = Number(lines.at(-1)?.split(" ")[1]);
  // The chain to the overflow, then the frame's own pass, bounded by its
  // rounds, not cycles started over.
  assert.ok(runs > 256 && runs < 10000, `${runs} runs`);
});

test("a timer whose closure throws keeps running and fires again", { skip }, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    // The frame clock: what the timers trace of getTimer is the same on every run.
    realTime: null,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compiler(out)("TimerThrows"), 3), scripting);
  player.frameRate = 10;
  await player.start();
  // The first firing's error reaches the host; the timer is back in its place for the next.
  assert.throws(() => player.tick());
  assert.equal(scripting.now, scripting.clock);
  player.tick();
  assert.deepEqual(lines, ["firing 1 200 true", "firing 2 300 true"]);
});

test("a bitmap a timeline places is a Bitmap, its bound class its data's with HasImage alone", {
  skip,
}, async () => {
  const compile = compiler(out);
  const data = compile(
    "PlacedData",
    'package { import flash.display.BitmapData; public class PlacedData extends BitmapData { public function PlacedData(w:int = -1, h:int = -1) { super(w, h); trace("data", w, h, arguments.length); } } }',
  );
  const root = compile(
    "PlacedRoot",
    "package { import flash.display.*; import flash.utils.*; public class PlacedRoot extends Sprite { public function PlacedRoot() { var b:Bitmap = getChildAt(0) as Bitmap; trace(getQualifiedClassName(b.bitmapData), b.bitmapData.width, b.bitmapData.getPixel32(1, 0).toString(16)); } } }",
  );
  // The same, its first frame empty: a jump to frame 2 places the bitmap.
  const seeking = compile(
    "SeekRoot",
    "package { import flash.display.*; import flash.utils.*; public class SeekRoot extends MovieClip { public function SeekRoot() { gotoAndStop(2); var b:Bitmap = getChildAt(0) as Bitmap; trace(getQualifiedClassName(b.bitmapData), b.bitmapData.width); } } }",
  );
  const pixels = Uint8Array.from([0xff, 1, 2, 3, 0x80, 0x40, 0x20, 0x10]);
  const bitmapSwf = (hasImage: boolean, seek = false) =>
    w.swf({
      width: 100,
      height: 50,
      frameCount: seek ? 2 : 1,
      tags: [
        w.fileAttributes(true),
        w.tag(36, Uint8Array.from([1, 0, 5, 2, 0, 1, 0, ...zlibCompress(pixels)]), true),
        w.doAbc(data, "PlacedData"),
        w.doAbc(seek ? seeking : root, seek ? "SeekRoot" : "PlacedRoot"),
        w.symbolClass([
          [1, "PlacedData"],
          [0, seek ? "SeekRoot" : "PlacedRoot"],
        ]),
        ...(seek ? [w.showFrame()] : []),
        w.place({ depth: 1, character: 1, hasImage: hasImage || undefined }),
        w.showFrame(),
        w.end(),
      ],
    });

  const run = async (hasImage: boolean, seek = false) => {
    const lines: string[] = [];
    const scripting = new Scripting(await createCodegen(wasm), {
      print: (line) => lines.push(line),
      debugger: true,
    });
    await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
    const player = new Player(bitmapSwf(hasImage, seek), scripting);
    const error = await player.start().then(
      () => null,
      (e: unknown) => scripting.rt.toString(e as avm2.Value),
    );
    return { lines, error };
  };

  // As Flash Pro places one: the class constructed with (1, 1), the pixels its own.
  assert.deepEqual(await run(true), {
    lines: ["data 1 1 2", "PlacedData 2 807f4020"],
    error: null,
  });
  // A jump to the frame that places it constructs it alike.
  assert.deepEqual(await run(true, true), { lines: ["data 1 1 2", "PlacedData 2"], error: null });
  // Without HasImage Flash takes the class for a display object's: constructed bare, then refused.
  const bare = await run(false);
  assert.deepEqual(bare.lines, ["data -1 -1 0"]);
  assert.equal(
    bare.error,
    "TypeError: Error #2022: Class PlacedData$ must inherit from DisplayObject to link to a symbol.",
  );
});

test("getTimer reads the real clock as it runs on within a frame, or the frame clock if asked", {
  skip,
}, async () => {
  const compile = compiler(out);
  const swf = bare(
    compile(
      "ClockReads",
      `package {
        import flash.display.Sprite;
        import flash.utils.getTimer;
        public class ClockReads extends Sprite {
          public function ClockReads() { var a:int = getTimer(); var b:int = getTimer(); trace(a, b); }
        }
      }`,
    ),
    1,
    "ClockReads",
  );

  // The frame clock: the first frame's time at 24 fps, the same at each read.
  const framed: string[] = [];
  const stepped = new Scripting(await createCodegen(wasm), {
    print: (l) => framed.push(l),
    realTime: null,
  });
  await stepped.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(swf, stepped).start();
  assert.deepEqual(framed, ["42 42"]);

  // A host's clock, read once as the player starts, then at each getTimer:
  // the time since, which runs on within the frame.
  let clock = 1000;
  const real: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (l) => real.push(l),
    realTime: () => (clock += 2),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(swf, scripting).start();
  assert.deepEqual(real, ["2 4"]);
});

test("getTimer runs on in real time by default", { skip }, async () => {
  const swf = bare(
    compiler(out)(
      "ClockRuns",
      `package {
        import flash.display.Sprite;
        import flash.utils.getTimer;
        public class ClockRuns extends Sprite {
          public function ClockRuns() {
            var start:int = getTimer();
            for (var n:int = 0; getTimer() == start && n < 100000000; n++) {}
            trace(getTimer() > start);
          }
        }
      }`,
    ),
    1,
    "ClockRuns",
  );
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (l) => lines.push(l) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(swf, scripting).start();
  assert.deepEqual(lines, ["true"]);
});
