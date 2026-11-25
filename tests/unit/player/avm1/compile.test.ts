// Lazy blocks preserve their region identity, function bodies and AOT source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createCodegen } from "@swf2es/codegen";
import { Avm1 } from "../../../../packages/player/dist/avm1/avm1.js";
import { lazyBlocks } from "../../../../packages/player/dist/avm1/compile.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Runtime } from "../../../../packages/runtime/dist/avm1/index.js";
import { Avm1Assembler, constant } from "../../../avm1-assembler.ts";
import { backwardSwf } from "../../../avm1-backward.ts";

const module = await WebAssembly.compile(
  await readFile(new URL("../../../../packages/codegen/dist/codegen.wasm", import.meta.url)),
);

for (const version of [4, 8]) {
  test(`SWF ${version} compiles only blocks that run, once each, retaining functions and pools`, async () => {
    const codegen = await createCodegen(module);
    const first = new Avm1Assembler()
      .constantPool("from the pool")
      .defineFunction("f", [], new Avm1Assembler().push(constant(0)).trace().push(42).op("Return"))
      .end()
      .bytes();
    const second = new Avm1Assembler().push(0, "f").op("CallFunction").trace().end().bytes();
    const never = new Avm1Assembler().push("not executed").trace().end().bytes();
    const bytes = new Uint8Array([...first, ...second, ...never]);
    const actions = {
      version,
      blocks: [
        { offset: 0, length: first.length },
        { offset: first.length, length: second.length },
        { offset: first.length + second.length, length: never.length },
      ],
    };
    const aot = codegen.compileActions(bytes, actions);
    const compile = codegen.compileActionBlocks.bind(codegen);
    const calls: number[][] = [];
    codegen.compileActionsModule = () => {
      throw new Error("eager compilation");
    };
    codegen.compileActionBlocks = (source, list, indices) => {
      calls.push(indices);
      const entries = compile(source, list, indices);
      for (const [index, entry] of entries) {
        assert.equal(entry, aot.entries[index]);
      }

      return entries;
    };
    const rt = new Runtime();
    const blocks = lazyBlocks(codegen, bytes, actions, rt);
    const regions = blocks.slice();
    const lines: string[] = [];
    const host = { trace: (text: string) => lines.push(text), play() {}, stop() {}, halt() {} };
    const root = rt.newObject();
    const activation = () => rt.activation([], [], {}, root, host);
    assert.deepEqual(calls, []);
    rt.run(blocks[0], activation());
    assert.deepEqual(calls, [[0]]);
    assert.equal(blocks[0], regions[0]);
    assert.ok(blocks[0].length > 1);
    rt.run(blocks[1], activation());
    rt.run(blocks[1], activation());
    assert.deepEqual(calls, [[0], [1]]);
    assert.equal(blocks[1], regions[1]);
    assert.deepEqual(lines, ["from the pool", "42", "from the pool", "42"]);
  });
}

test("a SWF whose code jumps back before its blocks is let go of with the player", async () => {
  const codegen = await createCodegen(module);
  const avm1 = new Avm1(codegen, { print() {}, realTime: null, audio: null });
  const player = new Player(backwardSwf(), null, avm1);
  await player.start();
  player.tick();
  assert.equal(codegen.heldActions().held, 1, "its units compiled");
  player.destroy();
  assert.equal(codegen.heldActions().held, 0);
});
