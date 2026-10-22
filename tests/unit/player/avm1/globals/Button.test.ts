// Button's AS2 face in node: a button's prototype, its depth, and a class
// registered for its symbol, which a button does not take.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm1 } from "@swf2es/runtime";
import { Avm1 } from "../../../../../packages/player/dist/avm1/avm1.js";
import { ButtonObject } from "../../../../../packages/player/dist/display/buttonobject.js";
import { Player } from "../../../../../packages/player/dist/player.js";
import { buttonStatesMovie } from "../../../../avm1-button-states.ts";
import { flashAssembler, script } from "../../../../avm1-script.ts";
import * as w from "../../../../swf-writer.ts";

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

const as1 = (source: string) => w.doAction([...script(source, 6)(flashAssembler()).end().bytes()]);

test("a button is a Button, whose depth it gives, and a class registered for its symbol is not its", async () => {
  const lines: string[] = [];
  const swf = w.swf({
    version: 6,
    width: 10,
    height: 10,
    frameCount: 1,
    tags: [
      w.shape({
        id: 1,
        bounds: [0, 200, 0, 200],
        fills: [0xff0000],
        paths: [{ fill1: 1, commands: [{ move: [0, 0] }, { line: [200, 0] }, { line: [0, 200] }] }],
      }),
      w.button(2, 1, []),
      w.exportAssets([[2, "button"]]),
      as1(`Object.registerClass("button", function () { trace("constructed"); });`),
      w.place({ depth: 3, character: 2, name: "b" }),
      as1(
        `trace(typeof b + " " + (b.__proto__ == Button.prototype) + " " + b.getDepth() + " " + b.enabled + " " + b.useHandCursor);`,
      ),
      w.showFrame(),
      w.end(),
    ],
  });
  const player = new Player(swf, null, new Avm1(codegen, { print: (line) => lines.push(line) }));
  await player.start();

  assert.deepEqual(lines, ["object true -16381 true true"]);
});

test("a button's blendMode is a clip's from SWF 8, listed", async () => {
  // adl: a DefineButton2 placed as btn.
  const lines: string[] = [];
  const source = `var line = [btn.blendMode], modes = ["layer", null, 259, true, "lAyEr", "add"];
for (var i = 0; i < modes.length; i++) { btn.blendMode = "invert"; btn.blendMode = modes[i]; line.push(btn.blendMode); }
var listed = false; for (var k in btn) { if (k == "blendMode") { listed = true; } }
trace(line.join(" ") + " " + listed);`;
  const swf = w.swf({
    version: 8,
    width: 10,
    height: 10,
    frameCount: 1,
    tags: [
      w.shape({
        id: 1,
        bounds: [0, 200, 0, 200],
        fills: [0xff0000],
        paths: [{ fill1: 1, commands: [{ move: [0, 0] }, { line: [200, 0] }, { line: [0, 200] }] }],
      }),
      w.button2(2, 1),
      w.place({ depth: 1, character: 2, name: "btn" }),
      w.doAction([...script(source, 8)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
  const player = new Player(swf, null, new Avm1(codegen, { print: (line) => lines.push(line) }));
  await player.start();

  assert.deepEqual(lines, ["normal layer normal multiply invert invert add true"]);
});

for (const version of [6, 8]) {
  test(`button state clips restart on re-entry while shared records keep playing (SWF ${version})`, async () => {
    let decodes = 0;
    const plays: { loops: number; endMs: number | undefined }[] = [];
    const vm = new Avm1(codegen, {
      realTime: null,
      audio: {
        async decode() {
          decodes++;
          return {
            durationMs: 100,
            play(_start, loops, _mix, shape) {
              plays.push({ loops, endMs: shape?.endMs });
              return { stop() {}, setMix() {} };
            },
          };
        },
      },
    });
    const player = new Player(buttonStatesMovie(version), null, vm);
    await player.start();
    try {
      const face = player.root.avm1;
      assert.ok(face);
      const events = () => avm1.get(face, "events", version);
      const button = player.root.children[0];
      assert.ok(button instanceof ButtonObject);
      const up = button.depths.get(1);
      const shared = button.depths.get(2);
      assert.ok(up);
      assert.ok(shared);
      assert.equal(events(), "US");
      assert.equal(decodes, 0);
      player.tick();
      const move = (type: "move" | "down" | "up", x = 20) =>
        player.pointer?.handle(type, { x, y: 20, button: 0 });
      move("move");
      assert.equal(events(), "USO");
      assert.equal(up.parent, null);
      assert.equal(button.depths.get(2), shared);
      move("down");
      const down = button.depths.get(1);
      assert.equal(events(), "USOD");
      player.tick();
      avm1.set(face, "ticks", "", version);
      player.tick();
      assert.equal(avm1.get(face, "ticks", version), "DS");
      move("up");
      assert.equal(events(), "USODO");
      move("down");
      assert.equal(events(), "USODOD");
      assert.notEqual(button.depths.get(1), down);
      move("up");
      move("move", 140);
      assert.equal(events(), "USODODOU");
      assert.equal(button.depths.get(2), shared);
      assert.notEqual(button.depths.get(1), up);
      for (let i = 0; i < 6; i++) {
        await Promise.resolve();
      }

      assert.equal(decodes, 1);
      assert.deepEqual(plays, [
        { loops: 8, endMs: 3000 / 44.1 },
        { loops: 8, endMs: 3000 / 44.1 },
      ]);
    } finally {
      player.destroy();
    }
  });
}

test("separate records at one depth recreate the same character when states change", async () => {
  // Native Flash Player 32: sharing a record and sharing only its character differ.
  const vm = new Avm1(codegen, { audio: null, realTime: null });
  const player = new Player(buttonStatesMovie(6, true), null, vm);
  await player.start();
  try {
    const face = player.root.avm1;
    assert.ok(face);
    const button = player.root.children[0];
    assert.ok(button instanceof ButtonObject);
    const shared = button.depths.get(2);
    const move = (type: "move" | "down" | "up") =>
      player.pointer?.handle(type, { x: 20, y: 20, button: 0 });
    move("move");
    assert.equal(button.depths.get(2), shared);
    move("down");
    assert.notEqual(button.depths.get(2), shared);
    assert.equal(avm1.get(face, "events", 6), "USODS");
    move("up");
    assert.equal(avm1.get(face, "events", 6), "USODSOS");
  } finally {
    player.destroy();
  }
});
