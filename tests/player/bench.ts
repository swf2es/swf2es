// Times the player on a synthetic SWF in headless Chrome: a few shape
// characters placed many times over, some moving each frame, some turning
// (which draws their lines again), a few replaced; what a busy timeline
// does. Prints the median and p90 of a frame's tick (the timeline), sync
// (the display list brought to Pixi), draw (Pixi's instructions, batches
// and GL calls) and gl (the wait for GL to finish them) after the first
// frames warm up. Chrome's software GL draws by default, so the draw is CPU
// time that compares run to run on one machine; --gpu lets Chrome use the
// machine's GPU, for what a user would see, and the output names which drew.
//
// --back-buffer makes the renderer as a host that draws blend modes must,
// with Pixi's back buffer. --antialias makes it multisampled, as a host
// made with `antialias: true`; with --back-buffer, what blends and
// filters resolve of it (render/resolve.ts) counts in the draw and gl.
//
// --rig N plays instead N instances of one animated character, a sprite of
// 12 outlined parts that turn and swell on a loop of 24 frames, all in
// step, as a game's crowd of the same creature does: what the lines cost
// when only their transforms change. --swap has each part taken off and
// another put in its place on every frame instead, as a frame-by-frame
// timeline does: what changing children costs, render group rebuilds and all.
// --fresh has the parts swell to a new size on every frame, never coming
// round again, so each frame strokes their lines anew: new contexts for the
// renderer to take on, as objects that turn and stretch in a game give it.
// --blurred has each place write a blur on the part too, as a tween of a
// filtered part writes its filters on every frame: each part filtered on
// its own, run again as it turns. --glide has the parts slide instead of
// turning, a move alone, whose filters' output is kept. --filtered K
// blurs only every K-th part, as --blurred does all: each filter ends the
// transform table's run (render/table.ts), which then draws only the parts
// between two, as in a game's creatures with a glow on every few parts.
// The rig has 12 parts, so any K of 12 or more blurs the first alone.
//
// --masks N plays instead N panels of a scrolling list, each a sprite of
// 20 rows clipped by a rectangle on the timeline (clipDepth), the rows
// sliding up a little each frame, as a game's inventory, chat or shop
// does: what the stencil masks cost. --unmasked places the rectangle as a
// plain shape instead, the same art with no mask, which bounds what any
// cheaper clip (a scissor) could gain.
//
// --idle K renders K times more after each frame with no tick between, as
// a host that draws on every animation frame does, and times those apart.
//
// --toggle N plays instead N text fields and N sprites drawn by Graphics,
// all taken off the list on one frame and put back on the next, as a
// pool's objects or a panel shown and hidden: what coming back costs.
// --toggle-static N does the same with N static texts of 24 glyphs and N
// shapes, the timeline's: what leaving costs, with glyphs that share a
// font's fills.
//
// --no-table draws the Graphics drawn alone each with a call of its own,
// as Pixi does, not through the transform table (render/table.ts): the two
// timed apart. --min-run N has the table draw only runs of N draws or
// more, and Pixi the shorter, to time where the table starts to gain.
//
// --branches N places N coloured branches of 128 shapes. A quarter replace
// one child each frame; the rest stay still, as scenery beside animated art.
// --toggle-branches N removes and reattaches those N branches every --toggle-every K frames.
// --nested-groups also renders nested Pixi groups while they leave and return.
//
// Each run also gives per-frame means of what the renderer did: GL draw
// calls, Pixi's unbatched Graphics and batches, render group rebuilds and
// their time, contexts tessellated with their vertices and time, buffer
// uploads and bytes, texture uploads, program switches, and the table's
// runs and draws. --allocs samples the heap and gives the KB the frames
// allocated, the player's start left out.
//
//   node tests/player/bench.ts [--shapes N | --rig N [--fresh] [--blurred | --filtered K] [--glide]
//     | --branches N | --toggle-branches N | --toggle N
//     | --toggle-static N | --masks N [--unmasked]] [--toggle-every K] [--nested-groups] [--frames N] [--idle K]
//     [--swap] [--gpu] [--back-buffer] [--antialias] [--allocs] [--no-table] [--min-run N]
//     [--json]
import * as w from "../swf-writer.ts";
import { benchPlayer } from "./chrome.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const shapes = option("shapes", 2000);
const rig = option("rig", 0);
const filtered = option("filtered", 0);
const branches = option("branches", 0);
const toggleBranches = option("toggle-branches", 0);
const toggleEvery = Math.max(1, option("toggle-every", 1));
const nestedGroups = args.includes("--nested-groups");
const idleRenders = option("idle", 0);
const toggle = option("toggle", 0);
const masks = option("masks", 0);
const toggleStatic = option("toggle-static", 0);
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

/** A part of the rig: a polygon of `sides`, filled and outlined thick, so that its joins are many and round. */
function part(id: number, sides: number): Uint8Array {
  const r = 300;
  const point = (k: number): [number, number] => [
    Math.round(r * Math.cos((2 * Math.PI * k) / sides)),
    Math.round(r * Math.sin((2 * Math.PI * k) / sides) * 0.6),
  ];
  const path: ({ move: [number, number] } | { line: [number, number] })[] = [{ move: point(0) }];
  for (let k = 1; k <= sides; k++) {
    path.push({ line: point(k) });
  }

  return w.shape({
    id,
    bounds: [-r - 60, r + 60, -r - 60, r + 60],
    fills: [0xff000000 | ((id * 0x2a6f3d) & 0xffffff)],
    lines: [{ width: 60, color: 0xff101010 }],
    paths: [{ fill1: 1, line: 1, commands: path }],
  });
}

/**
 * The rig: `count` instances of a sprite whose 12 parts turn and swell on a
 * loop of 24 frames. With `swap`, each part is taken off on every frame and
 * another put in its place, as a frame-by-frame animation's timeline does:
 * each frame changes the sprite's children, not only their transforms. With
 * `fresh`, the loop is as long as the run and the parts swell to a size no
 * other frame has. With `blurred`, each place writes a blur on its part,
 * or on every `filtered`-th part alone if that is given; with `glide`, the
 * parts slide to and fro instead of turning and swelling.
 */
function rigSwf(
  count: number,
  swap = false,
  fresh = false,
  blurred = false,
  glide = false,
): Uint8Array {
  const tags: Uint8Array[] = [w.fileAttributes(true), w.backgroundColor(0xffffff)];
  for (let i = 0; i < 4; i++) {
    tags.push(part(11 + i, 12 + 6 * i));
  }

  const loop = fresh ? frames : 24;
  const sprite: Uint8Array[] = [];
  for (let f = 0; f < loop; f++) {
    for (let i = 0; i < 12; i++) {
      const t = (2 * Math.PI * f) / loop;
      const a = 0.4 * Math.sin(t + i) * (i % 2 ? 1 : -1);
      const s = fresh ? 0.75 + (0.5 * ((f * 12 + i) % 997)) / 997 : 1 + 0.25 * Math.sin(t * 2 + i);
      const slide = glide ? Math.round(200 * Math.sin(t + i)) : 0;
      const matrix = {
        a: glide ? 1 : s * Math.cos(a),
        b: glide ? 0 : s * Math.sin(a),
        c: glide ? 0 : -s * Math.sin(a),
        d: glide ? 1 : s * Math.cos(a),
        tx: Math.round(400 * Math.cos(i)) + slide,
        ty: Math.round(400 * Math.sin(i * 1.7)),
      };
      const blurs = blurred && (filtered === 0 || i % filtered === 0) ? [3] : undefined;
      if (f === 0) {
        sprite.push(w.place({ depth: i + 1, character: 11 + (i % 4), matrix, blurs }));
      } else if (swap) {
        sprite.push(
          w.remove(i + 1),
          w.place({ depth: i + 1, character: 11 + ((i + f) % 4), matrix, blurs }),
        );
      } else {
        sprite.push(w.place({ depth: i + 1, move: true, matrix, blurs }));
      }
    }

    sprite.push(w.showFrame());
  }

  tags.push(w.sprite(20, loop, sprite));
  const columns = Math.ceil(Math.sqrt(count));
  for (let i = 0; i < count; i++) {
    tags.push(
      w.place({
        depth: i + 1,
        character: 20,
        matrix: {
          tx: Math.round(((i % columns) + 0.5) * (WIDTH / columns) * TWIPS),
          ty: Math.round((Math.floor(i / columns) + 0.5) * (HEIGHT / columns) * TWIPS),
        },
      }),
    );
  }

  tags.push(w.showFrame(), w.end());
  return w.swf({ width: WIDTH, height: HEIGHT, frameRate: 24, frameCount: 1, tags });
}

/** `count` text fields in the device font, placed on the one frame, for the page to toggle (--toggle). */
function toggleSwf(count: number): Uint8Array {
  const tags: Uint8Array[] = [w.fileAttributes(true), w.backgroundColor(0xffffff)];
  for (let i = 0; i < count; i++) {
    tags.push(
      w.editText(i + 1, `Damage ${i * 37}`, 2400, 400, 0, { color: 0xc02020 }),
      w.place({
        depth: i + 1,
        character: i + 1,
        matrix: { tx: ((i * 61) % 700) * TWIPS, ty: ((i * 29) % 560) * TWIPS },
      }),
    );
  }

  tags.push(w.showFrame(), w.end());
  return w.swf({ width: WIDTH, height: HEIGHT, frameRate: 24, frameCount: 1, tags });
}

/**
 * `count` static texts of 24 glyphs in a font of boxes, and as many shapes
 * of the synthetic timeline's characters, placed on the one frame, for the
 * page to toggle (--toggle-static).
 */
function toggleStaticSwf(count: number): Uint8Array {
  const letters = "abcdefgh";
  const tags: Uint8Array[] = [
    w.fileAttributes(true),
    w.backgroundColor(0xffffff),
    w.font3({
      id: 50,
      name: "Boxes",
      ascent: 800,
      descent: 200,
      glyphs: [...letters].map((char, k) => ({
        char,
        advance: 600,
        boxes: [
          [40, -100 - 60 * k, 560, 0],
          [100, -700, 300 + 30 * k, -150 - 60 * k],
        ],
      })),
    }),
  ];
  for (let id = 1; id <= 8; id++) {
    tags.push(character(id));
  }

  for (let i = 0; i < count; i++) {
    const glyphs: [number, number][] = Array.from({ length: 24 }, (_, k) => [(i + k) % 8, 180]);
    tags.push(
      w.staticText({
        id: 100 + i,
        bounds: [0, 4400, -400, 100],
        records: [{ font: 50, height: 300, color: 0x204060, x: 0, y: 0, glyphs }],
      }),
      w.place({
        depth: 2 * i + 1,
        character: 100 + i,
        matrix: { tx: ((i * 61) % 700) * TWIPS, ty: ((i * 29) % 560) * TWIPS },
      }),
      w.place({
        depth: 2 * i + 2,
        character: 1 + (i % 8),
        matrix: { a: 0.1, d: 0.1, tx: ((i * 37) % 780) * TWIPS, ty: ((i * 53) % 580) * TWIPS },
      }),
    );
  }

  tags.push(w.showFrame(), w.end());
  return w.swf({ width: WIDTH, height: HEIGHT, frameRate: 24, frameCount: 1, tags });
}

/**
 * `count` panels of a list of 20 rows that scrolls on a loop of 24 frames,
 * each clipped to its panel by a rectangle on depth 1, or with the
 * rectangle drawn under the rows instead where `unmasked` (--masks).
 */
function masksSwf(count: number, unmasked: boolean): Uint8Array {
  const tags: Uint8Array[] = [w.fileAttributes(true), w.backgroundColor(0xffffff)];
  for (let id = 1; id <= 8; id++) {
    tags.push(character(id));
  }

  const panelW = 100 * TWIPS;
  const panelH = 160 * TWIPS;
  tags.push(
    w.shape({
      id: 30,
      bounds: [0, panelW, 0, panelH],
      fills: [0xffe8e8f0],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [0, 0] },
            { line: [panelW, 0] },
            { line: [panelW, panelH] },
            { line: [0, panelH] },
            { line: [0, 0] },
          ],
        },
      ],
    }),
  );
  const rows = 20;
  const rowH = 20 * TWIPS;
  const loop = 24;
  const panel: Uint8Array[] = [];
  for (let f = 0; f < loop; f++) {
    if (f === 0) {
      panel.push(w.place({ depth: 1, character: 30, clipDepth: unmasked ? undefined : rows + 1 }));
    }

    for (let i = 0; i < rows; i++) {
      const matrix = {
        a: 0.4,
        d: 0.4,
        tx: (10 + (i % 4) * 25) * TWIPS,
        ty: 10 * TWIPS + i * rowH - Math.round((f / loop) * rows * rowH * 0.5),
      };
      panel.push(
        f === 0
          ? w.place({ depth: i + 2, character: 1 + (i % 8), matrix })
          : w.place({ depth: i + 2, move: true, matrix }),
      );
    }

    panel.push(w.showFrame());
  }

  tags.push(w.sprite(40, loop, panel));
  const columns = Math.ceil(Math.sqrt(count * 1.5));
  for (let i = 0; i < count; i++) {
    tags.push(
      w.place({
        depth: i + 1,
        character: 40,
        matrix: {
          tx: (i % columns) * Math.round(WIDTH / columns) * TWIPS,
          ty: Math.floor(i / columns) * Math.round(HEIGHT / Math.ceil(count / columns)) * TWIPS,
        },
      }),
    );
  }

  tags.push(w.showFrame(), w.end());
  return w.swf({ width: WIDTH, height: HEIGHT, frameRate: 24, frameCount: 1, tags });
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st... */
const ordinal = (n: number) => {
  const tens = Math.floor(n / 10) % 10;
  const suffix = tens === 1 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
};

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

/** Detailed, coloured branches whose independent timelines should not repack each other's art. */
function branchSwf(count: number): Uint8Array {
  const tags: Uint8Array[] = [w.fileAttributes(true), w.backgroundColor(0xffffff)];
  for (let id = 1; id <= 8; id++) {
    tags.push(character(id));
  }

  for (let branch = 0; branch < count; branch++) {
    const contents: Uint8Array[] = [];
    for (let i = 0; i < 128; i++) {
      contents.push(
        w.place({
          depth: i + 1,
          character: 1 + (i % 8),
          matrix: { tx: (i % 16) * 800, ty: Math.floor(i / 16) * 800 },
        }),
      );
    }

    contents.push(w.showFrame());
    const length = branch % 4 === 0 ? 24 : 1;
    for (let frame = 1; frame < length; frame++) {
      contents.push(w.place({ depth: 1, move: true, character: 1 + (frame % 8) }), w.showFrame());
    }

    contents.push(w.end());
    tags.push(
      w.sprite(20 + branch, length, contents),
      w.place({
        depth: branch + 1,
        character: 20 + branch,
        matrix: {
          a: 0.25,
          d: 0.25,
          tx: (branch % 4) * 4000 + 200,
          ty: Math.floor(branch / 4) * 2000 + 200,
        },
        colorTransform: { add: [24, -16, 32, 0] },
      }),
    );
  }

  tags.push(w.showFrame(), w.end());
  return w.swf({ width: WIDTH, height: HEIGHT, frameRate: 24, frameCount: 1, tags });
}

const swf =
  toggleBranches > 0
    ? branchSwf(toggleBranches)
    : toggle > 0
      ? toggleSwf(toggle)
      : toggleStatic > 0
        ? toggleStaticSwf(toggleStatic)
        : masks > 0
          ? masksSwf(masks, args.includes("--unmasked"))
          : branches > 0
            ? branchSwf(branches)
            : rig > 0
              ? rigSwf(
                  rig,
                  args.includes("--swap"),
                  args.includes("--fresh"),
                  args.includes("--blurred") || filtered > 0,
                  args.includes("--glide"),
                )
              : synthetic();
const result = await benchPlayer(
  swf,
  frames,
  args.includes("--gpu"),
  args.includes("--back-buffer"),
  idleRenders,
  toggleBranches > 0 ? 0 : toggle > 0 ? toggle : toggleStatic > 0 ? 0 : -1,
  args.includes("--antialias"),
  toggleEvery,
  nestedGroups,
  args.includes("--allocs"),
  !args.includes("--no-table"),
  args.includes("--min-run") ? option("min-run", 1) : undefined,
);
if (result.error) {
  console.error(result.error);
  process.exit(1);
}

/** Each meter's mean over `frames`, rounded to two places. */
function perFrame(frames: Record<string, number>[]): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const frame of frames) {
    for (const [key, value] of Object.entries(frame)) {
      sums[key] = (sums[key] ?? 0) + value;
    }
  }

  return Object.fromEntries(
    Object.entries(sums).map(([key, sum]) => [key, Math.round((sum / frames.length) * 100) / 100]),
  );
}

const tick = result.tick.slice(WARMUP);
const sync = result.sync.slice(WARMUP);
const draw = result.draw.slice(WARMUP);
const gl = result.gl.slice(WARMUP);
const total = tick.map((t, i) => t + sync[i] + draw[i] + gl[i]);
const stats = (values: number[]) => ({ median: quantile(values, 0.5), p90: quantile(values, 0.9) });
const summary = {
  shapes:
    toggleBranches > 0
      ? `toggle of ${toggleBranches} branches`
      : toggle > 0
        ? `toggle of ${toggle}`
        : toggleStatic > 0
          ? `static toggle of ${toggleStatic}`
          : masks > 0
            ? `${masks} masked lists${args.includes("--unmasked") ? ", unmasked" : ""}`
            : branches > 0
              ? `${branches} branches`
              : rig > 0
                ? `rig of ${rig}${["swap", "fresh", "blurred", "glide"].map((o) => (args.includes(`--${o}`) ? `, ${o}` : "")).join("")}${filtered > 0 ? `, every ${ordinal(filtered)} part blurred` : ""}`
                : shapes,
  counts: result.counts,
  heapMb: result.heap.map((b) => Math.round(b / 1e5) / 10),
  frames,
  swfBytes: swf.length,
  renderer: result.renderer,
  firstFrameMs: result.first,
  tick: stats(tick),
  sync: stats(sync),
  draw: stats(draw),
  gl: stats(gl),
  frame: stats(total),
  idle: stats(result.idle.slice(WARMUP * idleRenders)),
  // Each counter's mean over the measured frames: draws, rebuilds, tessellation, uploads.
  perFrame: perFrame(result.meters.slice(WARMUP)),
  ...(args.includes("--allocs")
    ? { allocatedKbPerFrame: Math.round(result.allocated / 1024 / (frames - 1)) }
    : {}),
  ...(toggleBranches > 0
    ? {
        attached: stats(total.filter((_, i) => (i + WARMUP + 2) % 2 === 0)),
        detached: stats(total.filter((_, i) => (i + WARMUP + 2) % 2 === 1)),
        attachedSync: stats(sync.filter((_, i) => (i + WARMUP + 2) % 2 === 0)),
        attachedDraw: stats(draw.filter((_, i) => (i + WARMUP + 2) % 2 === 0)),
        attachedGl: stats(gl.filter((_, i) => (i + WARMUP + 2) % 2 === 0)),
      }
    : {}),
};
if (args.includes("--json")) {
  console.log(JSON.stringify(summary));
} else {
  const ms = (v: number) => `${v.toFixed(2)} ms`;
  console.log(
    `${summary.shapes}${typeof summary.shapes === "string" ? "" : " shapes"}, ${frames} frames, SWF of ${swf.length} bytes; first frame ${ms(result.first)}; drawn by ${result.renderer}`,
  );
  console.log(
    `  counts  ${JSON.stringify(result.counts)}; JS heap ${summary.heapMb[0]} to ${summary.heapMb[1]} MB`,
  );
  console.log(`  tick    median ${ms(summary.tick.median)}  p90 ${ms(summary.tick.p90)}`);
  console.log(`  sync    median ${ms(summary.sync.median)}  p90 ${ms(summary.sync.p90)}`);
  console.log(`  draw    median ${ms(summary.draw.median)}  p90 ${ms(summary.draw.p90)}`);
  console.log(`  gl      median ${ms(summary.gl.median)}  p90 ${ms(summary.gl.p90)}`);
  if (idleRenders > 0) {
    console.log(
      `  idle    median ${ms(summary.idle.median)}  p90 ${ms(summary.idle.p90)} a render`,
    );
  }
  if (toggleBranches > 0 || toggle > 0 || toggleStatic > 0) {
    // Frame k (from 2) takes the objects off on odd k; the warm-up's 10 are left out.
    const off = sync.filter((_, i) => (i + WARMUP + 2) % 2 === 1);
    const on = sync.filter((_, i) => (i + WARMUP + 2) % 2 === 0);
    console.log(
      `  sync    off median ${ms(quantile(off, 0.5))}  back median ${ms(quantile(on, 0.5))}`,
    );
  }

  console.log(`  frame   median ${ms(summary.frame.median)}  p90 ${ms(summary.frame.p90)}`);
}
