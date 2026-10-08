// Times the player's per-frame walks of the display list in node: a tree
// of some 13,000 objects, clips bound to a class with a frame script,
// plain sprites, shapes and a few buttons, as a busy scene has them, on a
// root whose two frames each run a script, so that a frame's scripts take
// two rounds. Prints the median of a whole tick (the collect walk, every
// clip's advance and the frame's scripts' rounds) and of a lone
// runFrameScripts that finds nothing to run (one walk), in microseconds,
// over --reps runs of --frames frames each. Run with --expose-gc, it also
// prints what the player's objects hold of the heap once played.
//
//   node --expose-gc tests/player/walk-bench.ts [--rigs N] [--frames N] [--reps N]
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Player } from "../../packages/player/dist/player.js";
import { Scripting } from "../../packages/player/dist/scripting.js";
import * as w from "../swf-writer.ts";
import { libraryAbcs } from "./libraries.ts";
import { compiler } from "./scripts.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const rigs = option("rigs", 400);
const frames = option("frames", 200);
const reps = option("reps", 5);

const SOURCE = `package {
  import flash.display.MovieClip;

  public class WalkMain extends MovieClip {
    public var n:int = 0;

    public function WalkMain() {
      addFrameScript(0, tick, 1, tick);
    }

    private function tick():void {
      n++;
    }
  }

  public class WalkPart extends MovieClip {
    public static var made:int = 0;

    public function WalkPart() {
      addFrameScript(0, first);
    }

    private function first():void {
      made++;
    }
  }
}
`;

const square = (id: number) =>
  w.shape({
    id,
    bounds: [0, 200, 0, 200],
    fills: [0xff000000 | ((id * 0x2a6f3d) & 0xffffff)],
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

/**
 * `rigs` rigs, each a sprite of 12 parts, clips of the class WalkPart that
 * hold a shape, 4 shapes and a plain sprite of 2 shapes: 32 objects; every
 * 25th has a button too.
 */
function treeSwf(): Uint8Array {
  const abc = compiler()("WalkBench", SOURCE);
  const tags: Uint8Array[] = [
    w.fileAttributes(true),
    w.backgroundColor(0xffffff),
    square(1),
    square(2),
    w.sprite(10, 1, [w.place({ depth: 1, character: 1 }), w.showFrame(), w.end()]),
    w.sprite(11, 1, [
      w.place({ depth: 1, character: 1 }),
      w.place({ depth: 2, character: 2 }),
      w.showFrame(),
      w.end(),
    ]),
    w.button2(12, 2),
  ];
  const rig = (button: boolean) => {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < 12; i++) {
      parts.push(w.place({ depth: i + 1, character: 10, matrix: { tx: i * 100, ty: 0 } }));
    }

    for (let i = 0; i < 4; i++) {
      parts.push(w.place({ depth: 20 + i, character: 1 + (i % 2), matrix: { tx: i * 100 } }));
    }

    parts.push(w.place({ depth: 30, character: 11 }));
    if (button) {
      parts.push(w.place({ depth: 31, character: 12 }));
    }

    return [...parts, w.showFrame(), w.end()];
  };
  tags.push(w.sprite(20, 1, rig(false)), w.sprite(21, 1, rig(true)));
  tags.push(
    w.doAbc(abc, "WalkBench"),
    w.symbolClass([
      [0, "WalkMain"],
      [10, "WalkPart"],
    ]),
  );
  for (let i = 0; i < rigs; i++) {
    tags.push(w.place({ depth: i + 1, character: i % 25 === 0 ? 21 : 20 }));
  }

  tags.push(w.showFrame(), w.showFrame(), w.end());
  return w.swf({ width: 800, height: 600, frameRate: 24, frameCount: 2, tags });
}

const swf = treeSwf();
const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);
const scripting = new Scripting(await createCodegen(wasm), { print: () => {} });
await scripting.loadLibraries(libraryAbcs());
const gc = (globalThis as { gc?: () => void }).gc;
gc?.();
const heapBefore = process.memoryUsage().heapUsed;
const player = new Player(swf, scripting);
await player.start();

let objects = 0;
const count = (o: { children?: readonly unknown[] }) => {
  objects++;
  for (const c of o.children ?? []) {
    count(c as { children?: readonly unknown[] });
  }
};
count(player.stage);

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
const time = (f: () => void) => {
  const runs: number[] = [];
  for (let rep = 0; rep < reps; rep++) {
    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      f();
    }

    runs.push(((performance.now() - start) * 1000) / frames);
  }

  return runs;
};

// Warmed up first, so that the JIT has settled on both.
time(() => player.tick());
time(() => scripting.runFrameScripts(player.stage));
const ticks = time(() => player.tick());
const walks = time(() => scripting.runFrameScripts(player.stage));
const show = (runs: number[]) =>
  `median ${median(runs).toFixed(0)} us  (${runs.map((r) => r.toFixed(0)).join(", ")})`;
console.log(`${objects} objects under the stage, ${rigs} rigs, ${frames} frames x ${reps}`);
if (gc) {
  gc();
  const kb = (process.memoryUsage().heapUsed - heapBefore) / 1024;
  console.log(`  heap  ${kb.toFixed(0)} KB, ${((kb * 1024) / objects).toFixed(0)} bytes an object`);
}

console.log(`  tick  ${show(ticks)}`);
console.log(`  walk  ${show(walks)}`);
