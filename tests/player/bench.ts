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
// filters resolve of it (the Pixi fork's bounded resolves) counts in the draw and gl.
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
// --added adds the blurred parts to what is below (blend mode add), as a
// game's glowing effects do; with --back-buffer, as blends need it.
// --colored gives the blurred parts a colour transform, an alpha and
// offsets, which their chain's last pass applies to what the blur made;
// --fade changes the alpha on every frame, as a tween fades a creature.
//
// --pulse plays instead N rigs whose 12 parts are curved outlines, half of
// them swelling and shrinking a little as they turn, the others squashed
// one way, flipping as they turn about, as a game's creatures breathe and
// turn: each frame a new stretch for the lines, coming round again only
// with the loop, of --loop K frames (96). Their lines are --line W twips
// wide (1, a hairline's width on the screen, as most of a game's are).
// --squash F places each rig squashed to F of its height, so that its
// parts turn inside a parent scaled unevenly, as a game's limbs do inside
// a body squashed for a pose: each turn a stretch of its own.
// --pace MS waits that many milliseconds after each frame, so that what is
// kept by age (lines idle, render/strokes.ts) ages between the loop's turns.
//
// --masks N plays instead N panels of a scrolling list, each a sprite of
// 20 rows clipped by a rectangle on the timeline (clipDepth), the rows
// sliding up a little each frame, as a game's inventory, chat or shop
// does: what the stencil masks cost. --unmasked places the rectangle as a
// plain shape instead, the same art with no mask, which bounds what any
// cheaper clip (a scissor) could gain.
//
// --hover holds the mouse still over the stage's middle, as a user's often
// is, for what a SWF with scripts does for it each frame: with --scripted
// only, as the other SWFs have no scripts, and so no pointer.
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
// more as one multi-draw, to time where that starts to gain; it draws the
// shorter from its atlas a call a draw, or with --no-loop leaves them to Pixi.
// --multi-draw has the table make those multi-draws, as it did before it
// drew each run in one call that fetches its vertices (pulled draws), to
// time the two apart; --min-run and --no-loop are about them alone.
//
// --counts counts what the frames ask of GL and of Pixi's pipes (perFrame
// in --json's output), each call wrapped: left out, the frames are timed
// unwrapped.
//
// --scripted N plays instead N rigs whose 12 parts are clips of a class
// with a frame script, each frame taken off and new ones put in their
// place, turning and swelling; each new part's script calls a method on
// the root that looks its colour up and sets its colorTransform, as a
// game's animated characters colour their parts: what constructing
// objects, their events and frame scripts, and their lines cost. --still
// keeps the parts, moving them instead, on a root of two frames each with a
// script, so that every frame's scripts take two rounds: what walking a
// deep tree of scripted clips for frame scripts that rarely run costs.
//
// --branches N places N coloured branches of 128 shapes. A quarter replace
// one child each frame; the rest stay still, as scenery beside animated art.
// --toggle-branches N removes and reattaches those N branches every --toggle-every K frames.
// --nested-groups also renders nested Pixi groups while they leave and return.
//
// --town N plays instead a busy town: N characters, each of its own parts
// (outlined in hairlines, as a game's are), on loops of different lengths:
// every eighth one's body breathing, a uniform pulse of a few percent, limbs that turn
// and swing, one that turns about (squashed across, then mirrored), a hand
// whose timeline swaps its shape on every frame, and a glowing weapon; half
// of them mirrored, every fourth glowing whole, every third walking to and
// fro, all of them clips of a class with frame scripts. Among
// them scenery: N clips of eight clips of two shapes, every fourth glowing,
// every fifth pulsing. What a crowded town's characters cost: new lines for
// new stretches, filters, render group rebuilds and the frame's walks.
//
// --pipelined waits for the GPU only every 30 frames, not after each, so
// that its work goes on behind the next frames' as a page's does: the
// frames' mean is then the slower of the page's and the GPU's share, where
// the median of each part is the page's alone.
//
// --scroll N plays instead a BitmapData of N by N shown in a Bitmap, into
// which a script draws a sprite of drifting dots each frame and then
// scrolls it a pixel up, as a preloader's trail of rising sparks does: a
// draw on the GPU followed by an operation on the store's pixels, which
// must not bring them back from the GPU each frame (perFrame.readbacks).
//
// --triangles N plays instead a script that clears a Graphics and draws N
// textured triangles again on every frame, their vertices turning, with
// drawTriangles and a smoothed, repeating bitmap fill, as a 3D engine draws
// its meshes: what drawing them anew each frame costs, and whether it
// leaks. --culled has it cull half of them.
//
// --text N plays instead N TextFields of an embedded font, with advanced
// anti-aliasing (--normal: normal), white and black at four sizes; each
// frame a tenth of them take new text and a seventh move half a pixel:
// what drawing text, and drawing it again, costs.
//
// --cpu-profile FILE samples the frames after the warm-up in Chrome's
// profiler and writes the profile there (DevTools' Performance panel opens
// it); the bench prints the functions that took the most time themselves.
//
// Each run also gives per-frame means of what the renderer did: GL draw
// calls, Pixi's unbatched Graphics and batches, render group rebuilds and
// their time, contexts tessellated with their vertices and time, buffer
// uploads and bytes, texture uploads, program switches, and the table's
// runs and draws. --allocs samples the heap and gives the KB the frames
// allocated, the player's start left out; --profile FILE also writes the
// sampled profile there, for DevTools' Memory panel to open. After the
// frames, with the renderer still alive, it gives what the page holds after
// a full collection, the JS heap and array buffers' data apart; --snapshot
// FILE also writes a heap snapshot then.
//
//   node tests/player/bench.ts [--shapes N | --rig N [--fresh] [--blurred | --filtered K] [--added] [--glide]
//     [--colored [--fade]]
//     | --pulse N [--loop K] [--line W] [--squash F]
//     | --branches N | --toggle-branches N | --toggle N
//     | --toggle-static N | --masks N [--unmasked] | --scripted N [--still] | --town N | --scroll N
//     | --triangles N [--culled] | --text N [--normal]] [--toggle-every K] [--nested-groups] [--frames N] [--idle K]
//     [--swap] [--gpu] [--back-buffer] [--antialias] [--allocs [--profile FILE]] [--no-table]
//     [--min-run N] [--no-loop] [--multi-draw] [--counts] [--pace MS] [--hover]
//     [--json] [--write-swf FILE] [--cpu-profile FILE] [--pipelined] [--snapshot FILE]
//
// --write-swf FILE writes the SWF the options make and stops, for another
// browser or player to play.
import { readFileSync, writeFileSync } from "node:fs";
import * as w from "../swf-writer.ts";
import { stemFont } from "./cases.ts";
import { benchPlayer } from "./chrome.ts";
import { libraryAbcs } from "./libraries.ts";
import { compiler } from "./scripts.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const shapes = option("shapes", 2000);
const rig = option("rig", 0);
const filtered = option("filtered", 0);
const added = args.includes("--added");
const colored = args.includes("--colored");
const fade = args.includes("--fade");
const branches = option("branches", 0);
const toggleBranches = option("toggle-branches", 0);
const toggleEvery = Math.max(1, option("toggle-every", 1));
const nestedGroups = args.includes("--nested-groups");
const idleRenders = option("idle", 0);
const toggle = option("toggle", 0);
const masks = option("masks", 0);
const scripted = option("scripted", 0);
const pulse = option("pulse", 0);
const town = option("town", 0);
const scrolled = option("scroll", 0);
const triangles = option("triangles", 0);
const texts = option("text", 0);
const cpuProfile = args.includes("--cpu-profile")
  ? args[args.indexOf("--cpu-profile") + 1]
  : undefined;
const pace = option("pace", 0);
const profile = args.includes("--profile") ? args[args.indexOf("--profile") + 1] : undefined;
const toggleStatic = option("toggle-static", 0);
const frames = option("frames", 120);
if (args.includes("--hover") && scripted === 0) {
  console.error("--hover needs --scripted: the other SWFs have no scripts, and so no pointer");
  process.exit(2);
}

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
      const blendMode = blurs && added ? 8 : undefined;
      const alpha = fade ? 0.55 + 0.4 * Math.sin(t * 3 + i) : 0.8;
      const colorTransform =
        blurs && colored ? { mult: [1, 1, 1, alpha], add: [24, -16, 32, 0] } : undefined;
      if (f === 0) {
        sprite.push(
          w.place({
            depth: i + 1,
            character: 11 + (i % 4),
            matrix,
            blurs,
            blendMode,
            colorTransform,
          }),
        );
      } else if (swap) {
        sprite.push(
          w.remove(i + 1),
          w.place({
            depth: i + 1,
            character: 11 + ((i + f) % 4),
            matrix,
            blurs,
            blendMode,
            colorTransform,
          }),
        );
      } else {
        sprite.push(w.place({ depth: i + 1, move: true, matrix, blurs, colorTransform }));
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

/** A part of the pulsing rig: a lens of two curves and a curved tail, outlined `line` twips wide. */
function curvedPart(id: number, line: number, bulge: number): Uint8Array {
  const r = 300;
  return w.shape({
    id,
    bounds: [-r - 60, r + 60, -r - 60, r + 60],
    fills: [0xff000000 | ((id * 0x2a6f3d) & 0xffffff)],
    lines: [{ width: line, color: 0xff101010 }],
    paths: [
      {
        fill1: 1,
        line: 1,
        commands: [
          { move: [-r, 0] },
          { curve: [-r / 2, -bulge, 0, -bulge / 2] },
          { curve: [r / 2, 0, r, -r / 3] },
          { line: [r * 0.8, r / 4] },
          { curve: [0, bulge, -r, 0] },
        ],
      },
      { fill1: 0, line: 1, commands: [{ move: [r, 0] }, { curve: [r * 1.2, r / 2, r * 0.9, r] }] },
    ],
  });
}

/**
 * The pulsing rig: `count` instances of a sprite whose 12 curved parts
 * turn on a loop of `loop` frames, the even ones swelling and shrinking a
 * little, the odd ones squashed across, flipping as they turn about.
 */
function pulseSwf(count: number, loop: number, line: number, squash = 1): Uint8Array {
  const tags: Uint8Array[] = [w.fileAttributes(true), w.backgroundColor(0xffffff)];
  for (let i = 0; i < 4; i++) {
    tags.push(curvedPart(11 + i, line, 150 + 60 * i));
  }

  const sprite: Uint8Array[] = [];
  for (let f = 0; f < loop; f++) {
    for (let i = 0; i < 12; i++) {
      const t = (2 * Math.PI * f) / loop + i;
      const a = 0.4 * Math.sin(t);
      const s = 1 + 0.15 * Math.sin(2 * t);
      // Squashed across, flipping, never flat: a cosine kept a twentieth from none.
      const across = Math.cos(t);
      const sx = i % 2 ? Math.sign(across || 1) * Math.max(0.05, Math.abs(across)) : s;
      const sy = i % 2 ? 1 : s;
      const matrix = {
        a: sx * Math.cos(a),
        b: sx * Math.sin(a),
        c: -sy * Math.sin(a),
        d: sy * Math.cos(a),
        tx: Math.round(400 * Math.cos(i)),
        ty: Math.round(400 * Math.sin(i * 1.7)),
      };
      sprite.push(
        f === 0
          ? w.place({ depth: i + 1, character: 11 + (i % 4), matrix })
          : w.place({ depth: i + 1, move: true, matrix }),
      );
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
          a: 2 / columns,
          d: (2 / columns) * squash,
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

/** The scripted rig's classes: the root, whose setColor each part's first frame calls. */
const SCRIPTED_SOURCE = `package {
  import flash.display.MovieClip;
  import flash.geom.ColorTransform;

  public class Main extends MovieClip {
    public var frames:int = 0;

    public function Main() {
      addFrameScript(0, frame, 1, frame);
    }

    private function frame():void {
      frames++;
    }

    public var colors:Object = { skin: 0xe0b090, hair: 0x603010, cloth: 0x3050a0, trim: 0xc0c040 };

    public function setColor(mc:MovieClip):void {
      var c:uint = colors[mc.kind];
      var ct:ColorTransform = mc.transform.colorTransform;
      ct.redMultiplier = ((c >> 16) & 255) / 255;
      ct.greenMultiplier = ((c >> 8) & 255) / 255;
      ct.blueMultiplier = (c & 255) / 255;
      mc.transform.colorTransform = ct;
    }
  }

  public class Part extends MovieClip {
    private static const KINDS:Array = ["skin", "hair", "cloth", "trim"];
    private static var made:int = 0;
    public var kind:String;

    public function Part() {
      kind = KINDS[made++ & 3];
      addFrameScript(0, frame1);
    }

    private function frame1():void {
      MovieClip(root).setColor(this);
    }
  }
}
`;

/**
 * `count` rigs as --rig --swap makes them, each part a clip of the class
 * Part holding the part's shape, so that each frame constructs 12 Parts a
 * rig, whose first frames' scripts colour them (--scripted). With `still`,
 * the parts stay and move, as --rig's, on a root of two frames.
 */
function scriptedSwf(count: number, still: boolean): Uint8Array {
  const abc = compiler()("BenchScripted", SCRIPTED_SOURCE);
  // The page links it against these, which a fresh checkout has yet to copy out.
  libraryAbcs();
  const tags: Uint8Array[] = [w.fileAttributes(true), w.backgroundColor(0xffffff)];
  for (let i = 0; i < 4; i++) {
    tags.push(
      part(11 + i, 12 + 6 * i),
      w.sprite(31 + i, 1, [w.place({ depth: 1, character: 11 + i }), w.showFrame(), w.end()]),
    );
  }

  const loop = 24;
  const sprite: Uint8Array[] = [];
  for (let f = 0; f < loop; f++) {
    for (let i = 0; i < 12; i++) {
      const t = (2 * Math.PI * f) / loop;
      const a = 0.4 * Math.sin(t + i) * (i % 2 ? 1 : -1);
      const s = 1 + 0.25 * Math.sin(t * 2 + i);
      const matrix = {
        a: s * Math.cos(a),
        b: s * Math.sin(a),
        c: -s * Math.sin(a),
        d: s * Math.cos(a),
        tx: Math.round(400 * Math.cos(i)),
        ty: Math.round(400 * Math.sin(i * 1.7)),
      };
      if (still && f > 0) {
        sprite.push(w.place({ depth: i + 1, move: true, matrix }));
        continue;
      }

      if (f > 0) {
        sprite.push(w.remove(i + 1));
      }

      sprite.push(w.place({ depth: i + 1, character: 31 + ((i + f) % 4), matrix }));
    }

    sprite.push(w.showFrame());
  }

  tags.push(w.sprite(20, loop, [...sprite, w.end()]), w.doAbc(abc, "BenchScripted"));
  tags.push(
    w.symbolClass([
      [0, "Main"],
      [31, "Part"],
      [32, "Part"],
      [33, "Part"],
      [34, "Part"],
    ]),
  );
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

  tags.push(w.showFrame(), ...(still ? [w.showFrame()] : []), w.end());
  return w.swf({ width: WIDTH, height: HEIGHT, frameRate: 24, frameCount: still ? 2 : 1, tags });
}

/** The scrolling trail's class (--scroll): dots drawn into a bitmap each frame, then scrolled up a pixel. */
const SCROLL_SOURCE = `package {
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;

  public class Main extends Sprite {
    private var data:BitmapData;
    private var dots:Sprite = new Sprite();
    private var frame:int = 0;

    public function Main() {
      var size:int = SIZE;
      data = new BitmapData(size, size, true, 0);
      addChild(new Bitmap(data));
      for (var i:int = 0; i < 40; i++) {
        var dot:Shape = new Shape();
        dot.graphics.beginFill(0xffc040 + i * 4, 0.8);
        dot.graphics.drawCircle(0, 0, 2 + (i % 3));
        dots.addChild(dot);
      }

      addEventListener(Event.ENTER_FRAME, step);
    }

    private function step(e:Event):void {
      frame++;
      for (var i:int = 0; i < dots.numChildren; i++) {
        var dot:Shape = Shape(dots.getChildAt(i));
        dot.x = (i * 97 + frame * (1 + i % 5)) % data.width;
        dot.y = data.height - 8 - (i * 13 + frame) % 24;
      }

      data.draw(dots);
      data.scroll(0, -1);
    }
  }
}
`;

/** N TextFields in Stem (cases.ts), advanced or normal; a tenth take new text a frame, a seventh move. */
function textSwf(count: number, normal: boolean): Uint8Array {
  const source = `package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.text.*;

  public class Main extends Sprite {
    private var fields:Array = [];
    private var n:int = 0;

    public function Main() {
      for (var i:int = 0; i < ${count}; i++) {
        var t:TextField = new TextField();
        t.embedFonts = true;
        t.antiAliasType = "${normal ? "normal" : "advanced"}";
        t.defaultTextFormat = new TextFormat("Stem", 10 + (i % 4) * 4, i % 2 ? 0x000000 : 0x2040c0);
        t.autoSize = TextFieldAutoSize.LEFT;
        t.text = "123456 lmaW 123 lm";
        t.x = (i % 8) * 100;
        t.y = (int(i / 8) * 23) % 580;
        addChild(t);
        fields.push(t);
      }

      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function frame(e:Event):void {
      n++;
      for (var i:int = n % 10; i < fields.length; i += 10) {
        fields[i].text = "lm " + (n % 6 + 1) + (int(n / 6) % 6 + 1) + " aW 1234";
      }

      for (i = n % 7; i < fields.length; i += 7) {
        fields[i].x += n & 1 ? 0.5 : -0.5;
      }
    }
  }
}`;
  const abc = compiler()("BenchText", source);
  libraryAbcs();
  return w.swf({
    width: WIDTH,
    height: HEIGHT,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      stemFont(1),
      w.doAbc(abc, "Main"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** The scrolling trail (--scroll): a bitmap of `size` a side that a script draws into and scrolls each frame. */
function scrollSwf(size: number): Uint8Array {
  const abc = compiler()(`BenchScroll${size}`, SCROLL_SOURCE.replace("SIZE", String(size)));
  libraryAbcs();
  return w.swf({
    width: WIDTH,
    height: HEIGHT,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0x102040),
      w.doAbc(abc, `BenchScroll${size}`),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** The triangles' class (--triangles): a grid of textured triangles drawn anew each frame. */
const TRIANGLES_SOURCE = `package {
  import flash.display.BitmapData;
  import flash.display.Shape;
  import flash.display.Sprite;
  import flash.events.Event;

  public class Main extends Sprite {
    private var shape:Shape = new Shape();
    private var texture:BitmapData = new BitmapData(64, 64, false, 0);
    private var vertices:Vector.<Number> = new Vector.<Number>();
    private var indices:Vector.<int> = new Vector.<int>();
    private var uvt:Vector.<Number> = new Vector.<Number>();
    private var side:int;
    private var frame:int = 0;

    public function Main() {
      texture.perlinNoise(16, 16, 2, 7, true, true);
      // Two triangles a square of a grid of side by side squares.
      side = Math.ceil(Math.sqrt(COUNT / 2));
      for (var y:int = 0; y <= side; y++) {
        for (var x:int = 0; x <= side; x++) {
          vertices.push(0, 0);
          uvt.push(x / 8, y / 8, 1);
        }
      }

      for (var i:int = 0; i < COUNT; i++) {
        var square:int = i >> 1;
        var at:int = (square / side) * (side + 1) + square % side;
        // Every other square wound the other way, so that culling drops half the triangles.
        var a:int = i & 1 ? at + 1 : at;
        var b:int = i & 1 ? at + side + 2 : at + 1;
        var c:int = at + side + 1;
        if (square & 1) {
          indices.push(a, c, b);
        } else {
          indices.push(a, b, c);
        }
      }

      addChild(shape);
      addEventListener(Event.ENTER_FRAME, step);
    }

    private function step(e:Event):void {
      frame++;
      var turn:Number = frame / 48;
      var c:Number = Math.cos(turn);
      var s:Number = Math.sin(turn);
      var cell:Number = 560 / side;
      var k:int = 0;
      for (var y:int = 0; y <= side; y++) {
        for (var x:int = 0; x <= side; x++) {
          var px:Number = (x - side / 2) * cell;
          var py:Number = (y - side / 2) * cell;
          vertices[k++] = 400 + px * c - py * s;
          vertices[k++] = 300 + px * s + py * c;
        }
      }

      shape.graphics.clear();
      shape.graphics.beginBitmapFill(texture, null, true, true);
      shape.graphics.drawTriangles(vertices, indices, uvt, CULLING);
      shape.graphics.endFill();
    }
  }
}
`;

/** The triangles (--triangles): `count` textured triangles a script draws anew each frame. */
function trianglesSwf(count: number, culled: boolean): Uint8Array {
  const name = `BenchTriangles${count}${culled ? "Culled" : ""}`;
  const abc = compiler()(
    name,
    TRIANGLES_SOURCE.replaceAll("COUNT", String(count)).replace(
      "CULLING",
      culled ? '"positive"' : '"none"',
    ),
  );
  libraryAbcs();
  return w.swf({
    width: WIDTH,
    height: HEIGHT,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0x102040),
      w.doAbc(abc, name),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** The town's classes: the root, and each character's, whose frame scripts count its loops. */
const TOWN_SOURCE = `package {
  import flash.display.MovieClip;

  public class Main extends MovieClip {
    public var loops:int = 0;
  }

  public class Character extends MovieClip {
    private var turns:int = 0;

    public function Character() {
      addFrameScript(0, first, totalFrames - 1, last);
    }

    private function first():void {
      turns++;
    }

    private function last():void {
      Main(root).loops++;
    }
  }
}
`;

/**
 * The town (--town): `count` characters of their own parts, on loops of
 * different lengths, half of them mirrored, and scenery among them.
 */
function townSwf(count: number): Uint8Array {
  const abc = compiler()("BenchTown", TOWN_SOURCE);
  libraryAbcs();
  const tags: Uint8Array[] = [w.fileAttributes(true), w.backgroundColor(0xd0e0c0)];
  const PARTS = 12;
  const symbols: [number, string][] = [[0, "Main"]];
  // Scenery's shapes, shared by all its clips.
  for (let id = 1; id <= 8; id++) {
    tags.push(character(id));
  }

  let next = 1000;
  const characters: number[] = [];
  for (let c = 0; c < count; c++) {
    // Its own parts, each a clip of one frame holding a shape outlined in a hairline.
    const parts: number[] = [];
    for (let k = 0; k < PARTS; k++) {
      const shape = next++;
      const inner = next++;
      const clip = next++;
      tags.push(
        curvedPart(shape, 1, 120 + ((c * 37 + k * 53) % 200)),
        w.sprite(inner, 1, [w.place({ depth: 1, character: shape }), w.showFrame(), w.end()]),
        w.sprite(clip, 1, [w.place({ depth: 1, character: inner }), w.showFrame(), w.end()]),
      );
      parts.push(clip);
    }

    // A hand drawn frame by frame: four shapes, one swapped for the next on each frame.
    const hands: number[] = [];
    for (let k = 0; k < 4; k++) {
      hands.push(next);
      tags.push(curvedPart(next++, 1, 80 + 40 * k));
    }

    const hand = next++;
    const handFrames: Uint8Array[] = [];
    for (let f = 0; f < 4; f++) {
      handFrames.push(
        f === 0
          ? w.place({ depth: 1, character: hands[0] })
          : w.place({ depth: 1, move: true, character: hands[f] }),
        w.showFrame(),
      );
    }

    tags.push(w.sprite(hand, 4, [...handFrames, w.end()]));
    // The body: its parts turning and swinging on a loop of its own length.
    const loop = 36 + (c % 7) * 4;
    const body = next++;
    const frames: Uint8Array[] = [];
    for (let f = 0; f < loop; f++) {
      const t = (2 * Math.PI * f) / loop;
      for (let k = 0; k <= PARTS + 1; k++) {
        const swing = 0.35 * Math.sin(t + k);
        // Two parts pulse a few percent, one turns about, the rest only turn.
        const pulse = k === 2 || k === 5 ? 1 + 0.04 * Math.sin(2 * t + k) : 1;
        const across = k === 7 ? Math.cos(t) : 1;
        const sx = Math.sign(across || 1) * Math.max(0.05, Math.abs(across)) * pulse;
        const matrix = {
          a: sx * Math.cos(swing),
          b: sx * Math.sin(swing),
          c: -pulse * Math.sin(swing),
          d: pulse * Math.cos(swing),
          tx: Math.round(300 * Math.cos(k * 0.9)),
          ty: Math.round(450 * Math.sin(k * 1.3)),
        };
        const id = k < PARTS ? parts[k] : k === PARTS ? hand : parts[0];
        // The last a weapon, glowing.
        const glows = k === PARTS + 1 ? [{ color: 0x60c0ff, blur: 6, strength: 1.5 }] : undefined;
        frames.push(
          f === 0
            ? w.place({ depth: k + 1, character: id, matrix, glows })
            : w.place({ depth: k + 1, move: true, matrix }),
        );
      }

      frames.push(w.showFrame());
    }

    tags.push(w.sprite(body, loop, [...frames, w.end()]));
    // The character, a clip of the class Character: every eighth one's body breathing, its chest
    // rising a little.
    const figure = next++;
    const breaths: Uint8Array[] = [];
    for (let f = 0; f < loop; f++) {
      const s = c % 8 ? 1 : 1 + 0.01 * Math.sin((4 * Math.PI * f) / loop);
      breaths.push(
        f === 0
          ? w.place({ depth: 1, character: body, matrix: { a: 1, d: s } })
          : w.place({ depth: 1, move: true, matrix: { a: 1, d: s } }),
        w.showFrame(),
      );
    }

    tags.push(w.sprite(figure, loop, [...breaths, w.end()]));
    symbols.push([figure, "Character"]);
    // Every fourth glows whole, as a game marks a character; every third walks to and fro.
    const glows = c % 4 === 0 ? [{ color: 0xffe060, blur: 8, strength: 2 }] : undefined;
    if (c % 3 === 0) {
      const walker = next++;
      const steps: Uint8Array[] = [];
      for (let f = 0; f < 96; f++) {
        const matrix = { tx: Math.round(1200 * Math.sin((2 * Math.PI * f) / 96)) };
        steps.push(
          f === 0
            ? w.place({ depth: 1, character: figure, matrix, glows })
            : w.place({ depth: 1, move: true, matrix }),
          w.showFrame(),
        );
      }

      tags.push(w.sprite(walker, 96, [...steps, w.end()]));
      characters.push(walker);
    } else {
      const holder = next++;
      tags.push(
        w.sprite(holder, 1, [
          w.place({ depth: 1, character: figure, glows }),
          w.showFrame(),
          w.end(),
        ]),
      );
      characters.push(holder);
    }
  }

  // Scenery: clips of eight clips of two shapes, every fourth glowing, every fifth pulsing.
  const sceneryCount = count;
  const piece = next++;
  tags.push(
    w.sprite(piece, 1, [
      w.place({ depth: 1, character: 1, matrix: { a: 0.3, d: 0.3 } }),
      w.place({ depth: 2, character: 2, matrix: { a: 0.2, d: 0.2, tx: 100 } }),
      w.showFrame(),
      w.end(),
    ]),
  );
  const scenery = next++;
  const pieces: Uint8Array[] = [];
  for (let k = 0; k < 8; k++) {
    pieces.push(
      w.place({
        depth: k + 1,
        character: piece,
        matrix: { tx: (k % 4) * 300, ty: Math.floor(k / 4) * 300 },
      }),
    );
  }

  tags.push(w.sprite(scenery, 1, [...pieces, w.showFrame(), w.end()]));
  const pulsing = next++;
  const pulses: Uint8Array[] = [];
  for (let f = 0; f < 24; f++) {
    const s = 1 + 0.1 * Math.sin((2 * Math.PI * f) / 24);
    pulses.push(
      f === 0
        ? w.place({ depth: 1, character: scenery, matrix: { a: s, d: s } })
        : w.place({ depth: 1, move: true, matrix: { a: s, d: s } }),
      w.showFrame(),
    );
  }

  tags.push(
    w.sprite(pulsing, 24, [...pulses, w.end()]),
    w.doAbc(abc, "BenchTown"),
    w.symbolClass(symbols),
  );
  let depth = 1;
  for (let i = 0; i < sceneryCount; i++) {
    tags.push(
      w.place({
        depth: depth++,
        character: i % 5 === 0 ? pulsing : scenery,
        matrix: {
          tx: Math.round(((i * 97) % WIDTH) * TWIPS),
          ty: Math.round(((i * 61) % HEIGHT) * TWIPS),
        },
        glows: i % 4 === 0 ? [{ color: 0xfff080, blur: 4, strength: 1 }] : undefined,
      }),
    );
  }

  const columns = Math.ceil(Math.sqrt(count * 1.5));
  for (let c = 0; c < count; c++) {
    const flip = c % 2 ? -1 : 1;
    tags.push(
      w.place({
        depth: depth++,
        character: characters[c],
        matrix: {
          a: 0.12 * flip,
          d: 0.12,
          tx: Math.round(((c % columns) + 0.5) * (WIDTH / columns) * TWIPS),
          ty: Math.round((Math.floor(c / columns) + 0.6) * ((HEIGHT * 1.5) / columns) * TWIPS),
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
  texts > 0
    ? textSwf(texts, args.includes("--normal"))
    : triangles > 0
      ? trianglesSwf(triangles, args.includes("--culled"))
      : scrolled > 0
        ? scrollSwf(scrolled)
        : town > 0
          ? townSwf(town)
          : toggleBranches > 0
            ? branchSwf(toggleBranches)
            : toggle > 0
              ? toggleSwf(toggle)
              : toggleStatic > 0
                ? toggleStaticSwf(toggleStatic)
                : scripted > 0
                  ? scriptedSwf(scripted, args.includes("--still"))
                  : pulse > 0
                    ? pulseSwf(pulse, option("loop", 96), option("line", 1), option("squash", 1))
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
if (args.includes("--write-swf")) {
  writeFileSync(args[args.indexOf("--write-swf") + 1], swf);
  process.exit(0);
}

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
  profile,
  pace,
  cpuProfile,
  args.includes("--pipelined") ? 30 : 1,
  args.includes("--hover"),
  args.includes("--snapshot") ? args[args.indexOf("--snapshot") + 1] : undefined,
  !args.includes("--no-loop"),
  false,
  args.includes("--counts"),
  !args.includes("--multi-draw"),
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
    texts > 0
      ? `${texts} text fields, ${args.includes("--normal") ? "normal" : "advanced"}`
      : triangles > 0
        ? `${triangles} textured triangles drawn each frame${args.includes("--culled") ? ", culled" : ""}`
        : scrolled > 0
          ? `scrolled bitmap of ${scrolled}`
          : town > 0
            ? `town of ${town}`
            : toggleBranches > 0
              ? `toggle of ${toggleBranches} branches`
              : toggle > 0
                ? `toggle of ${toggle}`
                : toggleStatic > 0
                  ? `static toggle of ${toggleStatic}`
                  : scripted > 0
                    ? `scripted rig of ${scripted}${args.includes("--still") ? ", still" : ""}`
                    : pulse > 0
                      ? `pulsing rig of ${pulse}, loop of ${option("loop", 96)}, lines ${option("line", 1)} twips${pace > 0 ? `, ${pace} ms apart` : ""}`
                      : masks > 0
                        ? `${masks} masked lists${args.includes("--unmasked") ? ", unmasked" : ""}`
                        : branches > 0
                          ? `${branches} branches`
                          : rig > 0
                            ? `rig of ${rig}${["swap", "fresh", "blurred", "glide"].map((o) => (args.includes(`--${o}`) ? `, ${o}` : "")).join("")}${filtered > 0 ? `, every ${ordinal(filtered)} part blurred` : ""}${added ? ", added" : ""}`
                            : shapes,
  counts: result.counts,
  heapMb: result.heap.map((b) => Math.round(b / 1e5) / 10),
  retainedMb: {
    heap: Math.round(result.retained.heap / 1e5) / 10,
    buffers: Math.round(result.retained.buffers / 1e5) / 10,
  },
  frames,
  swfBytes: swf.length,
  renderer: result.renderer,
  firstFrameMs: result.first,
  tick: stats(tick),
  sync: stats(sync),
  draw: stats(draw),
  gl: stats(gl),
  frame: stats(total),
  // The frames' mean, whole: pipelined, the time the slower of the page and the GPU takes a frame.
  frameMean: Math.round((total.reduce((a, b) => a + b, 0) / total.length) * 100) / 100,
  idle: stats(result.idle.slice(WARMUP * idleRenders)),
  // Each counter's mean over the measured frames: draws, rebuilds, tessellation, uploads.
  ...(args.includes("--counts") ? { perFrame: perFrame(result.meters.slice(WARMUP)) } : {}),
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
/** A sampled CPU profile's self time by function and by where its code is from, in ms a frame. */
function selfTimes(path: string, measured: number): { areas: string[]; functions: string[] } {
  const profile = JSON.parse(readFileSync(path, "utf8")) as {
    nodes: {
      id: number;
      callFrame: { functionName: string; url: string; lineNumber: number };
    }[];
    samples: number[];
    timeDeltas: number[];
  };
  const byId = new Map(profile.nodes.map((n) => [n.id, n.callFrame]));
  const functions = new Map<string, number>();
  const areas = new Map<string, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    const frame = byId.get(profile.samples[i]);
    const dt = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    if (!frame || frame.functionName === "(idle)") {
      continue;
    }

    const url = frame.url.replace(/[?#].*/, "");
    const area = /^\(/.test(frame.functionName)
      ? frame.functionName
      : /pixi/.test(url)
        ? "pixi"
        : (/\/(player|runtime|codegen|format)\//.exec(url)?.[1] ?? (url ? "other" : "native"));
    const name = `${frame.functionName || "(anonymous)"} ${url.split("/").slice(-2).join("/")}:${frame.lineNumber + 1}`;
    functions.set(name, (functions.get(name) ?? 0) + dt);
    areas.set(area, (areas.get(area) ?? 0) + dt);
  }

  const top = (m: Map<string, number>, n: number) =>
    [...m]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${(v / measured).toFixed(3).padStart(7)} ms  ${k}`);
  return { areas: top(areas, 12), functions: top(functions, 30) };
}

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
  console.log(
    `  held    ${summary.retainedMb.heap} MB of JS heap and ${summary.retainedMb.buffers} MB of array buffers after a full collection`,
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

  console.log(
    `  frame   median ${ms(summary.frame.median)}  p90 ${ms(summary.frame.p90)}  mean ${ms(summary.frameMean)}`,
  );
  if (cpuProfile) {
    // Profiled from the 12th frame (page.ts, PROFILED_FROM) to the last.
    const { areas, functions } = selfTimes(cpuProfile, frames - 11);
    console.log("  self time a frame, by area:");
    console.log(areas.map((line) => `    ${line}`).join("\n"));
    console.log("  self time a frame, by function:");
    console.log(functions.map((line) => `    ${line}`).join("\n"));
  }
}
