// A SWF with a text field for the AVM1 text tests: what its frames trace,
// compiled by the release codegen.wasm.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Avm1 } from "../../../../packages/player/dist/avm1/avm1.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { flashAssembler, script } from "../../../avm1-script.ts";
import * as w from "../../../swf-writer.ts";

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

const as1 = (source: string, version: number) =>
  w.doAction([...script(source, version)(flashAssembler()).end().bytes()]);

/**
 * What `frames` trace, each a frame's actions, in a SWF of `version` whose
 * root places field `t` showing "Hello" at depth 1, bound to `variable`
 * where given, before the actions of frame `fieldFrame` (the first by
 * default), and clip `mc` at depth 2.
 */
export async function traces(
  frames: string[],
  version = 8,
  variable?: string,
  fieldFrame = 0,
): Promise<string[]> {
  const swf = w.swf({
    version,
    width: 200,
    height: 100,
    frameCount: frames.length,
    tags: [
      w.editText(1, "Hello", 2000, 400, 0, { variable }),
      w.sprite(2, 1, [w.showFrame(), w.end()]),
      w.place({ depth: 2, character: 2, name: "mc" }),
      ...frames.flatMap((source, i) => [
        ...(i === fieldFrame ? [w.place({ depth: 1, character: 1, name: "t" })] : []),
        as1(source, version),
        w.showFrame(),
      ]),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const errors: unknown[] = [];
  const avm1 = new Avm1(codegen, {
    print: (line) => lines.push(line),
    onUncaught: (error) => errors.push(error),
    realTime: null,
  });
  const player = new Player(swf, null, avm1);
  await player.start();
  for (let i = 1; i < frames.length; i++) {
    player.tick();
  }

  assert.deepEqual(errors, []);
  return lines;
}
