// The player's AVM1 in node, without a renderer: an AVM1 SWF's blocks,
// assembled here, compiled by the release codegen.wasm and run with the
// root timeline.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Avm1 } from "../../../../packages/player/dist/avm1/avm1.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Avm1Assembler, constant, type PushValue } from "../../../avm1-assembler.ts";
import * as w from "../../../swf-writer.ts";

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

/** A DoAction of what `write` assembles, and End. */
function doAction(write: (a: Avm1Assembler) => Avm1Assembler): Uint8Array {
  return w.doAction([...write(new Avm1Assembler()).end().bytes()]);
}

const traced = (...values: PushValue[]) =>
  doAction((a) => values.reduce<Avm1Assembler>((b, v) => b.push(v).trace(), a));

function movie(version: number, frames: Uint8Array[][], as3 = false): Uint8Array {
  return w.swf({
    version,
    width: 10,
    height: 10,
    frameCount: frames.length,
    tags: [
      ...(as3 || version >= 8 ? [w.fileAttributes(as3)] : []),
      ...frames.flatMap((tags) => [...tags, w.showFrame()]),
      w.end(),
    ],
  });
}

/** The lines a SWF traces in `frames` frames, and the errors its blocks threw. */
async function play(swf: Uint8Array, frames: number) {
  const lines: string[] = [];
  const errors: unknown[] = [];
  const avm1 = new Avm1(codegen, {
    print: (line) => lines.push(line),
    onUncaught: (error) => errors.push(error),
  });
  const player = new Player(swf, null, avm1);
  await player.start();
  for (let i = 1; i < frames; i++) {
    player.tick();
  }

  return { lines, errors, player, avm1 };
}

test("each frame's blocks run in order as the root enters it, and the root loops", async () => {
  const swf = movie(6, [[traced("1a"), traced("1b")], [], [traced("3")]]);
  const { lines, errors } = await play(swf, 5);

  assert.deepEqual(lines, ["1a", "1b", "3", "1a", "1b"]);
  assert.deepEqual(errors, []);
});

test("actions after the last ShowFrame run with the last frame, and a root without End stays on it", async () => {
  const swf = (header: number, end: boolean) =>
    w.swf({
      version: 6,
      width: 10,
      height: 10,
      frameCount: header,
      tags: [
        traced("1"),
        w.showFrame(),
        traced("2"),
        w.showFrame(),
        traced("tail"),
        ...(end ? [w.end()] : []),
      ],
    });

  for (const header of [1, 2, 5]) {
    assert.deepEqual((await play(swf(header, true), 4)).lines, [
      "1",
      "2",
      "tail",
      "1",
      "2",
      "tail",
    ]);
  }

  const { lines, player } = await play(swf(2, false), 5);
  assert.deepEqual(lines, ["1", "2", "tail"]);
  assert.equal(player.root.currentFrame, 2);
});

test("stop holds the root on its frame, whose actions do not run again", async () => {
  const swf = movie(6, [[traced("1")], [doAction((a) => a.push("2").trace().stop())]]);
  const { lines, player } = await play(swf, 5);

  assert.deepEqual(lines, ["1", "2"]);
  assert.equal(player.root.currentFrame, 2);
  assert.equal(player.root.playing, false);
});

test("a frame's blocks share the operand stack, which the next frame finds empty", async () => {
  const swf = movie(7, [[doAction((a) => a.push("left")), doAction((a) => a.trace())]]);
  const second = movie(7, [[doAction((a) => a.push("left"))], [doAction((a) => a.trace().stop())]]);

  assert.deepEqual((await play(swf, 1)).lines, ["left"]);
  assert.deepEqual((await play(second, 3)).lines, ["undefined"]);
});

test("a frame's blocks share the constant pool the last one set; the next frame's start without", async () => {
  const swf = movie(6, [
    [doAction((a) => a.constantPool("one")), doAction((a) => a.push(constant(0)).trace())],
    [doAction((a) => a.push(constant(0)).trace().stop())],
  ]);

  assert.deepEqual((await play(swf, 3)).lines, ["one", "undefined"]);
});

test("a DoInitAction runs before its frame's DoActions, once a sprite, its pool its own", async () => {
  const init = (text: string) =>
    w.doInitAction(1, [...new Avm1Assembler().constantPool(text).push(text).trace().end().bytes()]);
  const swf = movie(6, [
    [
      w.sprite(1, 1, [w.showFrame(), w.end()]),
      doAction((a) => a.push(constant(0)).trace()),
      init("init"),
      init("again"),
    ],
    [],
  ]);

  assert.deepEqual((await play(swf, 3)).lines, ["init", "undefined", "undefined"]);
});

test("values trace as AVM1 writes them, by version", async () => {
  const values = [undefined, null, true, false, 0.1, "a\rb"];

  assert.deepEqual((await play(movie(4, [[traced(...values)]]), 1)).lines, [
    "undefined",
    "null",
    "1",
    "0",
    "0.1",
    "a\rb",
  ]);
  assert.deepEqual((await play(movie(6, [[traced(...values)]]), 1)).lines, [
    "undefined",
    "null",
    "true",
    "false",
    "0.1",
    "a\rb",
  ]);
});

test("an AS3 SWF's blocks never run", async () => {
  const { lines } = await play(movie(9, [[traced("no")]], true), 2);

  assert.deepEqual(lines, []);
});

test("an action not done yet is reported, and the frame's next block runs", async () => {
  const swf = movie(6, [[doAction((a) => a.push("x").raw([0x1c])), traced("next")]]);
  const { lines, errors } = await play(swf, 1);

  assert.deepEqual(lines, ["next"]);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).name, "Avm1NotYet");
});

test("an action Flash cannot read stops the SWF there, every frame after", async () => {
  // A Push of value type 10, which Flash does not know.
  const swf = movie(6, [
    [doAction((a) => a.push("1").trace().raw([0x96, 2, 0, 10, 0])), traced("after")],
    [traced("2")],
  ]);
  const { lines, errors, player, avm1 } = await play(swf, 3);

  assert.deepEqual(lines, ["1"]);
  assert.deepEqual(errors, []);
  assert.ok(avm1.halted);
  assert.equal(player.root.currentFrame, 1);
});

test("a place whose clip actions run past its tag stops the SWF as the first of its events comes", async () => {
  /** Frame 2: an init, an action, a place of `events` whose record runs past it, an init. */
  const stopped = async (events: number) => {
    const past = new w.BitWriter().u16(0).u32(events).u32(events).u32(100).raw([0x07, 0x00]);
    const place = w.tag(26, new w.BitWriter().u8(0x80).u16(1).raw(past.done()).done());
    const init = (id: number, text: string) =>
      w.doInitAction(id, [...new Avm1Assembler().push(text).trace().end().bytes()]);
    const swf = movie(7, [
      [w.sprite(1, 1, [w.showFrame(), w.end()]), w.sprite(2, 1, [w.showFrame(), w.end()])],
      [init(1, "init"), traced("2"), place, init(2, "init after")],
      [traced("3")],
    ]);
    const { lines, avm1 } = await play(swf, 5);
    return { lines, halted: avm1.halted };
  };

  // load and initialize as the clip is placed, before the frame's actions.
  assert.deepEqual(await stopped(1 << 0), { lines: [], halted: true });
  assert.deepEqual(await stopped(1 << 9), { lines: [], halted: true });
  // construct after the frame's DoInitActions.
  assert.deepEqual(await stopped(1 << 18), { lines: ["init", "init after"], halted: true });
  // enterFrame at the next frame, whether or not the root moves on.
  assert.deepEqual(await stopped(1 << 1), {
    lines: ["init", "init after", "2"],
    halted: true,
  });
  // keyDown not until a key comes.
  assert.deepEqual(await stopped(1 << 6), {
    lines: ["init", "init after", "2", "3", "2"],
    halted: false,
  });
});
