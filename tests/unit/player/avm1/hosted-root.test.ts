// The names of an AVM1 movie an AS3 Loader holds, and its levels: Flash
// Player 32's Windows debug projector traced LoadedAvm1Root over this
// movie. Its root is `_root`, never
// `_level0`, and no `_levelN` names anything; loadMovieNum and a load
// into the root itself load nothing, and the Loader keeps one child, while
// a MovieClipLoader's load into a clip comes, its `_root` the movie's.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { flashAssembler, script } from "../../../avm1-script.ts";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";
import * as w from "../../../swf-writer.ts";

const out = fileURLToPath(new URL("../../out/loaded-avm1-root/", import.meta.url));
let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

const ROOT = `
function show(p) {
  trace(p + " this " + this + " | _root " + _root + " | _level0 " + _level0 + " | _level1 " + _level1 + " | _parent " + _parent);
  trace(p + " a " + a + " | " + a._target + " | " + targetPath(a) + " | " + a.b + " | " + a.b._target + " | " + targetPath(a.b));
  trace(p + " root " + this._target + " | " + targetPath(this) + " | " + eval("_level0") + " | " + eval("/a") + " | " + eval("_root.a") + " | " + _root["_level0"]);
}
var a = createEmptyMovieClip("a", 1);
a.createEmptyMovieClip("b", 1);
show("1");
loadMovieNum("level.swf", 1);
var c = createEmptyMovieClip("c", 2);
new MovieClipLoader().loadClip("child.swf", c);
this._name = "renamed";
var n = 0;
onEnterFrame = function () {
  n++;
  if (n == 2) {
    this.loadMovie("level.swf");
  }
  if (n == 6) {
    show("6");
    trace("6 level " + _level1 + " " + typeof _level1 + " " + c.getBytesTotal());
    var ref = a;
    a.removeMovieClip();
    var again = createEmptyMovieClip("a", 3);
    trace("6 ref " + ref + " " + (ref == again) + " " + ref._name);
    delete onEnterFrame;
  }
};`;

function movie(source: string): Uint8Array {
  return w.swf({
    version: 8,
    width: 320,
    height: 240,
    frameCount: 1,
    tags: [
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}

test("a loaded AVM1 movie's root is _root, with no levels, as Flash names them", {
  skip,
}, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    url: "http://example.test/main.swf",
    // Slow to come, as from a network: settled() waits for the movie's own loads too.
    fetch: async ({ url }) => {
      await new Promise((done) => setTimeout(done, 20));
      return {
        bytes: url.endsWith("root.swf")
          ? movie(ROOT)
          : url.endsWith("child.swf")
            ? movie('trace("child " + _root + " " + _parent);')
            : movie('trace("level " + this);'),
        status: 200,
        headers: [],
      };
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(
    bare(compiler(out)("LoadedAvm1Root"), 1, "LoadedAvm1Root", 320, 240),
    scripting,
  );
  try {
    await player.start();
    for (let i = 0; i < 16; i++) {
      await scripting.settled();
      player.tick();
    }

    assert.deepEqual(lines, [
      "1 this _root | _root _root | _level0 undefined | _level1 undefined | _parent undefined",
      "1 a _root.a | /a | _root.a | _root.a.b | /a/b | _root.a.b",
      "1 root / | _root | undefined | _root.a | _root.a | undefined",
      "child _root _root",
      "6 this _root | _root _root | _level0 undefined | _level1 undefined | _parent undefined",
      "6 a _root.a | /a | _root.a | _root.a.b | /a/b | _root.a.b",
      "6 root / | _root | undefined | _root.a | _root.a | undefined",
      "6 level undefined undefined 78",
      "6 ref _root.a true a",
      "as3:children 1 renamed",
    ]);
  } finally {
    player.destroy();
  }
});
