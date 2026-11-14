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
// --orphans N has a script make N panels, rigs bound to a class, and keep
// them off the display list, each held by a listener for a frame's events,
// as a game keeps its hidden panels: thousands of clips the frames' walks
// may visit. --menu K then times a script that builds a menu of K rows, as
// one a click opens: each row a clip whose first frame holds a button whose
// states are clips, each such button made running the frame scripts due, as
// Flash does (Scripting.construct). Each build is timed alone, the menu then
// dropped and played till it is no orphan, --reps times after two to warm up.
//
// --old N loads a SWF of version 9 of N rigs onto the stage, as a game
// loads its older asset SWFs: clips whose gotos run no cycle, which every
// round of frame scripts lists, due or not.
//
//   node --expose-gc tests/player/walk-bench.ts [--rigs N] [--frames N] [--reps N]
//     [--orphans N] [--menu K] [--old N]
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { avm2 } from "@swf2es/runtime";
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
const orphans = option("orphans", 0);
const menu = option("menu", 0);
const old = option("old", 0);

const SOURCE = readFileSync(new URL("./scripts/WalkBench.as", import.meta.url), "utf8");

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

/** A rig's parts: 12 clips of character 10, 4 shapes and the sprite 11, and a button 12 too if `button`. */
function rig(button: boolean): Uint8Array[] {
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
}

/** The characters rig() places: two squares, a clip of one, a sprite of both and a button. */
function rigParts(): Uint8Array[] {
  return [
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
}

/** `count` rigs in a SWF of version 9 with no code: every clip a MovieClip of its own SWF's version. */
function oldSwf(count: number): Uint8Array {
  const tags: Uint8Array[] = [w.fileAttributes(true), ...rigParts(), w.sprite(20, 1, rig(false))];
  for (let i = 0; i < count; i++) {
    tags.push(w.place({ depth: i + 1, character: 20, matrix: { tx: (i % 20) * 40, ty: 300 } }));
  }

  tags.push(w.showFrame(), w.end());
  return w.swf({ version: 9, width: 800, height: 600, frameRate: 24, frameCount: 1, tags });
}

/**
 * `rigs` rigs, each a sprite of 12 parts, clips of the class WalkPart that
 * hold a shape, 4 shapes and a plain sprite of 2 shapes: 32 objects; every
 * 25th has a button too. With --old, the SWF of version 9 it loads (WalkOld).
 */
function treeSwf(): Uint8Array {
  const abc = compiler()("WalkBench", SOURCE);
  const tags: Uint8Array[] = [w.fileAttributes(true), w.backgroundColor(0xffffff), ...rigParts()];
  if (old > 0) {
    tags.push(w.binaryData(40, oldSwf(old)));
  }

  tags.push(w.sprite(20, 1, rig(false)), w.sprite(21, 1, rig(true)), w.sprite(22, 1, rig(false)));
  // A menu's row: a shape, and a button whose every state is a WalkPart.
  tags.push(
    w.button2(24, 10),
    w.sprite(23, 1, [
      w.place({ depth: 1, character: 1 }),
      w.place({ depth: 2, character: 24, matrix: { tx: 200 } }),
      w.showFrame(),
      w.end(),
    ]),
  );
  tags.push(
    w.doAbc(abc, "WalkBench"),
    w.symbolClass([
      [0, "WalkMain"],
      [10, "WalkPart"],
      [22, "WalkPanel"],
      [23, "WalkRow"],
      ...(old > 0 ? ([[40, "WalkOld"]] as [number, string][]) : []),
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

const main = player.root.object as avm2.AsObject;
const call = (name: string, ...args: avm2.Value[]) =>
  scripting.rt.call(scripting.rt.getProperty(main, avm2.qname(avm2.publicNs, name)), main, ...args);
if (old > 0) {
  call("loadOld");
  const loaded = avm2.qname(avm2.publicNs, "oldLoaded");
  for (let i = 0; i < 200 && scripting.rt.getProperty(main, loaded) !== true; i++) {
    await scripting.settled();
    player.tick();
  }

  if (scripting.rt.getProperty(main, loaded) !== true) {
    throw new Error("the SWF of version 9 did not load");
  }
}

if (orphans > 0) {
  call("keep", orphans);
  // Orphans once the frame that made them ends.
  player.tick();
}

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
console.log(
  `${objects} objects under the stage, ${rigs} rigs, ${old} of version 9, ${frames} frames x ${reps}`,
);
if (gc) {
  gc();
  const kb = (process.memoryUsage().heapUsed - heapBefore) / 1024;
  console.log(`  heap  ${kb.toFixed(0)} KB, ${((kb * 1024) / objects).toFixed(0)} bytes an object`);
}

console.log(`  tick  ${show(ticks)}`);
console.log(`  walk  ${show(walks)}`);

if (menu > 0) {
  const builds: number[] = [];
  for (let rep = 0; rep < reps + 2; rep++) {
    const start = performance.now();
    call("build", menu);
    const ms = performance.now() - start;
    if (rep >= 2) {
      builds.push(ms * 1000);
    }

    call("drop");
    // Played till the dropped menu is no orphan (Lifecycle's ORPHAN_FRAMES), as each build was
    // made in a player whose earlier menus had gone.
    for (let i = 0; i < 121; i++) {
      player.tick();
    }
  }

  console.log(`  menu of ${menu} rows, ${orphans} orphan panels  ${show(builds)}`);
}
