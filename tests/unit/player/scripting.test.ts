// The player's AS3 half in node, without a renderer: a document class
// compiled in the oracle's container, loaded through the release
// codegen.wasm, constructed on the root with the timeline's children in
// place, its frame scripts run in frame order.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../oracle/oracle.ts";
import type { Container, MovieClip } from "../../../packages/player/dist/display.js";
import { Player } from "../../../packages/player/dist/player.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
import { bare, innerSwf, scripted } from "../../player/cases.ts";
import { libraryAbcs } from "../../player/libraries.ts";
import { compiler, compileScripts } from "../../player/scripts.ts";

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

      throw new Error("404");
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compile("LoadsUrl"), 4), scripting);
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
  const [first, , second] = player.root.children.map((loader) => (loader as Container).children[0]);
  assert.ok(first.object && second.object);
  assert.notEqual(first.object, second.object);
  assert.equal(Object.getPrototypeOf(second.object), Object.getPrototypeOf(first.object));

  // The nested SWF's content reports the nested SWF as its loaderURL (the
  // last field of addedToStage); the four loaded clips' scripts run in tree
  // order, the two older ones back on their first frame.
  await scripting.settled();
  player.tick();
  assert.deepEqual(lines.splice(0), [
    ...content,
    "frame 4 1 1",
    "inner frame 1 true true true true",
    "inner frame 2",
    "inner frame 1 true true true true",
    "inner frame 2",
  ]);
});
