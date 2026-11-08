// AVM1 names looked up on clips with many children, in fresh node
// processes, two built checkouts interleaved: the pointer moved over a
// thousand clips, each asked whether it takes the pointer as a button
// (onPress and the rest), and a script reading members a clip with many
// children does not have, and a child of it by name. No rendering.
//
//   node tests/bench/avm1-names.ts [<checkout A> <checkout B>] [runs, 5]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { flashAssembler, script } from "../avm1-script.ts";
import * as w from "../swf-writer.ts";

const here = fileURLToPath(new URL("../../", import.meta.url));

/** Forty clips of 25 square children each, every tenth with onRelease; a frame script reading names on one. */
const SOURCE = `
for (var i = 0; i < 40; i++) {
  var c = _root.createEmptyMovieClip("c" + i, i);
  c._x = (i % 8) * 12;
  c._y = Math.floor(i / 8) * 12;
  for (var j = 0; j < 25; j++) {
    var d = c.createEmptyMovieClip("d" + j, j);
    d.beginFill(0xff0000);
    d.moveTo(0, 0); d.lineTo(10, 0); d.lineTo(10, 10); d.lineTo(0, 10);
    d.endFill();
  }
  if (i % 10 == 0) { c.onRelease = function() {}; }
}
var reads = 0;
onEnterFrame = function() {
  var t = _root.c39;
  for (var k = 0; k < 2000; k++) {
    if (t.missing == undefined) { reads++; }
    if (t.d24._visible) { reads++; }
  }
};
stop();`;

if (process.argv[2] === "--child") {
  const checkout = process.argv[3];
  const built = (path: string) => pathToFileURL(join(checkout, "packages", path)).href;
  const { createCodegen } = (await import(
    built("codegen/dist/index.js")
  )) as typeof import("../../packages/codegen/dist/index.js");
  const { Avm1 } = (await import(
    built("player/dist/avm1/avm1.js")
  )) as typeof import("../../packages/player/dist/avm1/avm1.js");
  const { Player } = (await import(
    built("player/dist/player.js")
  )) as typeof import("../../packages/player/dist/player.js");
  const codegen = await createCodegen(
    await WebAssembly.compile(readFileSync(join(checkout, "packages/codegen/dist/codegen.wasm"))),
  );
  const swf = w.swf({
    version: 8,
    width: 100,
    height: 60,
    frameCount: 1,
    tags: [
      w.doAction([...script(SOURCE, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
  const errors: string[] = [];
  const avm1 = new Avm1(codegen, {
    print() {},
    onUncaught: (error) => errors.push(String(error)),
    realTime: null,
    audio: null,
  });
  const player = new Player(swf, null, avm1);
  await player.start();
  // The scene built, and both measures warmed.
  for (let i = 0; i < 20; i++) {
    player.tick(false);
  }

  const pointer = player.pointer;
  assert.ok(pointer);
  assert.equal(player.root.children.length, 40, "the scene's clips");
  const moves = (n: number) => {
    for (let k = 0; k < n; k++) {
      pointer.handle("move", { x: (k * 13) % 100, y: (k * 7) % 60 });
    }
  };
  moves(500);
  let begin = performance.now();
  moves(5000);
  const pick = (performance.now() - begin) / 5000;
  begin = performance.now();
  for (let i = 0; i < 200; i++) {
    player.tick(false);
  }
  const frame = (performance.now() - begin) / 200;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ pick, frame }));
} else {
  const [a, b] = [process.argv[2] ?? here, process.argv[3] ?? here].map((d) => resolve(d));
  const runs = Number(process.argv[4] ?? 5);
  const results = new Map<string, { pick: number[]; frame: number[] }>([
    [a, { pick: [], frame: [] }],
    [b, { pick: [], frame: [] }],
  ]);
  const self = fileURLToPath(import.meta.url);
  for (let r = 0; r < runs; r++) {
    for (const checkout of r % 2 === 0 ? [a, b] : [b, a]) {
      const out = execFileSync(process.execPath, [self, "--child", checkout], { encoding: "utf8" });
      const { pick, frame } = JSON.parse(out.trim().split("\n").at(-1) as string);
      results.get(checkout)?.pick.push(pick);
      results.get(checkout)?.frame.push(frame);
    }
  }

  const median = (v: number[]) => [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)];
  for (const [checkout, { pick, frame }] of results) {
    console.log(
      `${checkout}: pointer move ${(median(pick) * 1000).toFixed(1)} us, frame of 4000 reads ${median(frame).toFixed(3)} ms`,
    );
  }
}
