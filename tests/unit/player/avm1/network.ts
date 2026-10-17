// An AVM1 SWF of one frame of script, played in node with the hosts a
// network test gives it, for XML's, LoadVars' and XMLSocket's tests: what
// it traces, and the movie, to deliver the network's answers between
// frames.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Avm1, type Avm1Options } from "../../../../packages/player/dist/avm1/avm1.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { flashAssembler, script } from "../../../avm1-script.ts";
import * as w from "../../../swf-writer.ts";

const codegen = await createCodegen(
  await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  ),
);

export interface Played {
  lines: string[];
  avm1: Avm1;
  player: Player;
  /** Between frames: what the network answered since, delivered, its callbacks traced. */
  deliver(): Promise<void>;
  /** The errors nothing caught, none by the end of a test. */
  errors: unknown[];
}

/** `source` played as a SWF of `version`, its URL `file:///t/test.swf` unless `options` give one. */
export async function play(
  source: string,
  options: Avm1Options = {},
  version = 8,
): Promise<Played> {
  const swf = w.swf({
    version,
    width: 10,
    height: 10,
    frameCount: 1,
    tags: [
      w.doAction([...script(source, version)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const errors: unknown[] = [];
  const avm1 = new Avm1(codegen, {
    print: (line) => lines.push(line),
    onUncaught: (error) => errors.push(error),
    realTime: null,
    audio: null,
    url: "file:///t/test.swf",
    ...options,
  });
  const player = new Player(swf, null, avm1);
  await player.start();
  return {
    lines,
    avm1,
    player,
    errors,
    deliver: async () => {
      await avm1.settled();
      avm1.network();
    },
  };
}

/** `lines` taken, emptied, after the errors are checked to be none. */
export function take(played: Played): string[] {
  assert.deepEqual(played.errors, []);
  return played.lines.splice(0);
}
