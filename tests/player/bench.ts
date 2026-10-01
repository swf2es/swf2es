// Times the player on a synthetic SWF in headless Chrome: a few shape
// characters placed many times over, some moving each frame, some turning
// (which draws their lines again), a few replaced; what a busy timeline
// does. Prints the median and p90 of a frame's tick (the timeline) and
// render (the display list synced to Pixi and drawn) after the first frames
// warm up. Chrome's software GL draws, so render times are CPU times and
// compare run to run on one machine, not to a GPU.
//
//   node tests/player/bench.ts [--shapes N] [--frames N] [--json]
import * as w from "../swf-writer.ts";
import { benchPlayer } from "./chrome.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const shapes = option("shapes", 2000);
const frames = option("frames", 120);
const WARMUP = 10;
const WIDTH = 800;
const HEIGHT = 600;
const TWIPS = 20;

// A 32-bit LCG, so the SWF is the same every run.
let seed = 7;
const random = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return (seed >>> 8) / 2 ** 24;
};

/** A character: a regular polygon of `sides`, outlined on odd ids, with a hole on id 8, a curved side on id 7. */
function character(id: number): Uint8Array {
  const sides = 2 + id;
  const r = 400;
  const point = (k: number): [number, number] => [
    Math.round(r * Math.cos((2 * Math.PI * k) / sides)),
    Math.round(r * Math.sin((2 * Math.PI * k) / sides)),
  ];
  const commands: (
    | { move: [number, number] }
    | { line: [number, number] }
    | { curve: [number, number, number, number] }
  )[] = [{ move: point(0) }];
  for (let k = 1; k <= sides; k++) {
    const [x, y] = point(k);
    if (id === 7 && k === 1) {
      commands.push({ curve: [Math.round(r * 1.4), Math.round(r * 0.4), x, y] });
    } else {
      commands.push({ line: [x, y] });
    }
  }

  const paths: { fill1: number; line?: number; commands: typeof commands }[] = [
    { fill1: 1, line: id % 2 ? 1 : undefined, commands },
  ];
  if (id === 8) {
    paths.push({
      fill1: 1,
      commands: [
        { move: [-150, -150] },
        { line: [150, -150] },
        { line: [150, 150] },
        { line: [-150, 150] },
        { line: [-150, -150] },
      ],
    });
  }

  return w.shape({
    id,
    bounds: [-r - 40, r + 40, -r - 40, r + 40],
    fills: [0xff000000 | ((id * 0x1f3b5d) & 0xffffff)],
    lines: id % 2 ? [{ width: 40, color: 0xff202020 }] : [],
    paths,
  });
}

/** The SWF: `shapes` instances on frame 1, then each frame 30% move, 10% turn and 2% are replaced. */
function synthetic(): Uint8Array {
  const tags: Uint8Array[] = [w.fileAttributes(true), w.backgroundColor(0xffffff)];
  for (let id = 1; id <= 8; id++) {
    tags.push(character(id));
  }

  const origin = Array.from({ length: shapes }, () => [
    Math.round(random() * WIDTH * TWIPS),
    Math.round(random() * HEIGHT * TWIPS),
  ]);
  for (let i = 0; i < shapes; i++) {
    tags.push(
      w.place({
        depth: i + 1,
        character: 1 + (i % 8),
        matrix: { tx: origin[i][0], ty: origin[i][1] },
      }),
    );
  }

  tags.push(w.showFrame());
  for (let f = 2; f <= frames; f++) {
    for (let i = 0; i < shapes; i++) {
      const [x, y] = origin[i];
      const kind = i % 50;
      if (kind < 15) {
        // Moving: along a circle, a translation only.
        const a = f / 10 + i;
        tags.push(
          w.place({
            depth: i + 1,
            move: true,
            matrix: {
              tx: x + Math.round(600 * Math.cos(a)),
              ty: y + Math.round(600 * Math.sin(a)),
            },
          }),
        );
      } else if (kind < 20) {
        // Turning: the linear part changes, so the lines are drawn again.
        const a = f / 20 + i;
        tags.push(
          w.place({
            depth: i + 1,
            move: true,
            matrix: {
              a: Math.cos(a),
              b: Math.sin(a),
              c: -Math.sin(a),
              d: Math.cos(a),
              tx: x,
              ty: y,
            },
          }),
        );
      } else if (kind === 20) {
        // Replaced by another character, a new child in the display list.
        tags.push(
          w.place({ depth: i + 1, character: 1 + ((i + f) % 8), matrix: { tx: x, ty: y } }),
        );
      }
    }

    tags.push(w.showFrame());
  }

  tags.push(w.end());
  return w.swf({ width: WIDTH, height: HEIGHT, frameRate: 24, frameCount: frames, tags });
}

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

const swf = synthetic();
const result = await benchPlayer(swf, frames);
if (result.error) {
  console.error(result.error);
  process.exit(1);
}

const tick = result.tick.slice(WARMUP);
const render = result.render.slice(WARMUP);
const total = tick.map((t, i) => t + render[i]);
const stats = (values: number[]) => ({ median: quantile(values, 0.5), p90: quantile(values, 0.9) });
const summary = {
  shapes,
  frames,
  swfBytes: swf.length,
  firstFrameMs: result.first,
  tick: stats(tick),
  render: stats(render),
  frame: stats(total),
};
if (args.includes("--json")) {
  console.log(JSON.stringify(summary));
} else {
  const ms = (v: number) => `${v.toFixed(2)} ms`;
  console.log(
    `${shapes} shapes, ${frames} frames, SWF of ${swf.length} bytes; first frame ${ms(result.first)}`,
  );
  console.log(`  tick    median ${ms(summary.tick.median)}  p90 ${ms(summary.tick.p90)}`);
  console.log(`  render  median ${ms(summary.render.median)}  p90 ${ms(summary.render.p90)}`);
  console.log(`  frame   median ${ms(summary.frame.median)}  p90 ${ms(summary.frame.p90)}`);
}
