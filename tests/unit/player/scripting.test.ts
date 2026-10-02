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
import type { avm2 } from "@swf2es/runtime";
import { containerEngine } from "../../../oracle/oracle.ts";
import type { Container, MovieClip } from "../../../packages/player/dist/display.js";
import { Player } from "../../../packages/player/dist/player.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
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
    fetch: async (url, signal) => {
      fetches.push(url);
      signal.addEventListener("abort", () => aborted.push(url));
      if (url.endsWith("inner.swf") || url.endsWith("deep.swf")) {
        return inner;
      }

      if (url.endsWith("nested.swf")) {
        return nested;
      }

      if (url.endsWith("replacer.swf")) {
        return replacer;
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

  // The same SWF again, into the one domain: its classes are the first
  // load's, as Flash keeps a domain's definitions, and it plays on its own.
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
  assert.equal(Object.getPrototypeOf(second.object), Object.getPrototypeOf(first.object));

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

test("a stalled URLStream does not hold up a later Loader load", { skip }, async () => {
  const compile = compiler(out);
  const inner = innerSwf(compile("Inner"));
  const scripting = new Scripting(await createCodegen(wasm), {
    print: () => {},
    url: "http://example.test/outer.swf",
    fetch: (url) =>
      url.endsWith("never.bin") ? new Promise<Uint8Array>(() => {}) : Promise.resolve(inner),
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

test("timers fire in the order of their times, each at its own time", { skip }, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
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
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  // Five timers started A to E, three stopped at once: B and C, both due at 300, keep their order.
  const player = new Player(bare(compiler(out)("TimerTies"), 3), scripting);
  player.frameRate = 10;
  await player.start();
  player.tick();
  player.tick();
  assert.deepEqual(lines, ["B 300", "C 300"]);
});

test("a timer whose closure throws keeps running and fires again", { skip }, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
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
  const pixels = Uint8Array.from([0xff, 1, 2, 3, 0x80, 0x40, 0x20, 0x10]);
  const bitmapSwf = (hasImage: boolean) =>
    w.swf({
      width: 100,
      height: 50,
      frameCount: 1,
      tags: [
        w.fileAttributes(true),
        w.tag(36, Uint8Array.from([1, 0, 5, 2, 0, 1, 0, ...zlibCompress(pixels)]), true),
        w.doAbc(data, "PlacedData"),
        w.doAbc(root, "PlacedRoot"),
        w.symbolClass([
          [1, "PlacedData"],
          [0, "PlacedRoot"],
        ]),
        w.place({ depth: 1, character: 1, hasImage: hasImage || undefined }),
        w.showFrame(),
        w.end(),
      ],
    });

  const run = async (hasImage: boolean) => {
    const lines: string[] = [];
    const scripting = new Scripting(await createCodegen(wasm), {
      print: (line) => lines.push(line),
      debugger: true,
    });
    await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
    const player = new Player(bitmapSwf(hasImage), scripting);
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
  // Without HasImage Flash takes the class for a display object's: constructed bare, then refused.
  const bare = await run(false);
  assert.deepEqual(bare.lines, ["data -1 -1 0"]);
  assert.equal(
    bare.error,
    "TypeError: Error #2022: Class PlacedData$ must inherit from DisplayObject to link to a symbol.",
  );
});
