// What the player asks of GL in a frame, held to a baseline that may only
// go down: draw calls (a multi-draw one call), the draws they make (a
// multi-draw as many as its count), program, vertex array and framebuffer
// binds, and uniform calls, each a mean over 60 frames after a warm-up.
// The page's clock moves a frame's time a tick and no more (page.ts,
// benchSwf's clock), so that what the player keeps or lets go by age, as
// render groups settle after 2 s unchanged, comes on the same frames on a
// slow CI runner as on a fast machine; the warm-up lasts at least 3 s of
// that clock, and until the transform table's atlas has made no buffer for
// 10 frames, so that the counted frames are a steady scene's. The site's crowd and bounce demos play, and three SWFs made
// here: a crowd of filled, stroked, bitmap and gradient parts under colour
// transforms, half of it still; blend modes, a mask, a glow left still and
// a filtered sprite multiplied between shapes; and a timeline that
// replaces, removes and adds shapes and morphs every frame. Software GL
// and a GPU must count the same, so the scenes stay within the texture
// units of any batch. Buffers made anew and copied on the GPU, as a
// growing geometry atlas makes them (render/table.ts), are printed too.
//
//   node tests/player/draw-counts.ts [--update] [--gpu] [--runs N] [case...]
//
// --update writes the counts as the new baseline, draw-counts.json; --runs
// plays each case N times and fails if any count differs between them;
// --write-swfs DIR writes the cases' SWFs there and stops, for another player.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildDemos } from "../../apps/site/demos.ts";
import { zlibCompress } from "../../packages/format/dist/index.js";
import * as w from "../swf-writer.ts";
import { benchPlayer } from "./chrome.ts";
import { libraryAbcs } from "./libraries.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const baselinePath = `${here}draw-counts.json`;

/** The fewest frames of warm-up: past render/settle.ts's SETTLE_MS at 30 frames a second. */
const WARM_UP = 90;
/** Frames without a buffer made that end the warm-up, and the most it lasts. */
const STEADY = 10;
const WARM_UP_MOST = 240;
const COUNTED = 60;
/** The counts the baseline holds, each a mean a frame. */
const KEYS = ["calls", "subDraws", "useProgram", "bindVertexArray", "bindFramebuffer", "uniforms"];
/** Printed beside them, not held to a baseline: the atlas' allocations and copies. */
const BUFFERS = ["bufferData", "bufferDataBytes", "copyBufferSubData", "copyBufferSubDataBytes"];

/** WebGL 2's least MAX_TEXTURE_IMAGE_UNITS, SwiftShader's: a batch that fills them splits where a GPU's would not. */
const MOST_TEXTURES = 16;

type Counts = Record<string, number>;

/** An ellipse of 8 curves about (cx, cy), radii rx and ry, in twips. */
function ellipse(cx: number, cy: number, rx: number, ry: number): w.PathCommand[] {
  const at = (a: number, k = 1): [number, number] => [
    Math.round(cx + Math.cos(a) * rx * k),
    Math.round(cy + Math.sin(a) * ry * k),
  ];
  const commands: w.PathCommand[] = [{ move: at(0) }];
  const reach = 1 / Math.cos(Math.PI / 8);
  for (let i = 0; i < 8; i++) {
    const a = ((i + 0.5) * Math.PI) / 4;
    const b = ((i + 1) * Math.PI) / 4;
    commands.push({ curve: [...at(a, reach), ...at(b)] });
  }

  return commands;
}

/** A regular polygon of `sides` about the origin, `r` twips out. */
function polygon(sides: number, r: number): w.PathCommand[] {
  const at = (i: number): [number, number] => [
    Math.round(Math.cos((2 * Math.PI * i) / sides) * r),
    Math.round(Math.sin((2 * Math.PI * i) / sides) * r),
  ];
  const commands: w.PathCommand[] = [{ move: at(0) }];
  for (let i = 1; i <= sides; i++) {
    commands.push({ line: at(i) });
  }

  return commands;
}

function ellipseShape(
  id: number,
  rx: number,
  ry: number,
  fill: w.ShapeSpec["fills"][number],
  line?: { width: number; color: number },
): Uint8Array {
  return w.shape({
    id,
    bounds: [-rx - 40, rx + 40, -ry - 40, ry + 40],
    fills: [fill],
    lines: line ? [line] : [],
    paths: [{ fill1: 1, line: line ? 1 : 0, commands: ellipse(0, 0, rx, ry) }],
  });
}

/** An 8 by 8 checkerboard, premultiplied ARGB, in a DefineBitsLossless2. */
function checkerBitmap(id: number): Uint8Array {
  const pixels: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      pixels.push(...((x + y) % 2 ? [255, 240, 200, 60] : [255, 40, 90, 200]));
    }
  }

  const body = [id & 0xff, id >> 8, 5, 8, 0, 8, 0, ...zlibCompress(Uint8Array.from(pixels))];
  return w.tag(36, Uint8Array.from(body), true);
}

/**
 * 24 figures of a stroked body, a head and a gradient belly, half with a
 * bitmap-filled head; a third under an offset colour transform, the rest
 * none; the first half still, the rest moving and turning every frame.
 */
function mixedCrowd(): Uint8Array {
  const tags: Uint8Array[] = [
    w.backgroundColor(0xeeeeee),
    checkerBitmap(1),
    ellipseShape(2, 300, 500, 0x4477aa, { width: 40, color: 0x112233 }),
    ellipseShape(3, 220, 220, {
      bitmap: 1,
      type: 0x41,
      matrix: { a: 55, d: 55, tx: -220, ty: -220 },
    }),
    ellipseShape(4, 220, 220, 0xddbb99, { width: 30, color: 0x553311 }),
    ellipseShape(5, 200, 260, {
      type: 0x10,
      matrix: { a: 0.03, d: 0.03 },
      stops: [
        [0, 0xffcc00],
        [255, 0xcc3300],
      ],
    }),
  ];
  for (const [id, head] of [
    [10, 3],
    [11, 4],
  ]) {
    tags.push(
      w.sprite(id, 1, [
        w.place({ depth: 1, character: 2 }),
        w.place({ depth: 2, character: head, matrix: { ty: -700 } }),
        w.place({ depth: 3, character: 5, matrix: { ty: 80 } }),
        w.showFrame(),
        w.end(),
      ]),
    );
  }

  const count = 24;
  const frames = 120;
  const placed = (i: number, frame: number) => {
    const moving = i >= count / 2;
    const t = moving ? frame / frames : 0;
    const turn = moving ? Math.sin(2 * Math.PI * t * 3 + i) * 0.3 : 0;
    return {
      a: Math.cos(turn),
      b: Math.sin(turn),
      c: -Math.sin(turn),
      d: Math.cos(turn),
      tx: Math.round(
        (40 + (i % 8) * 60 + (moving ? Math.sin(2 * Math.PI * t * 2 + i) * 30 : 0)) * 20,
      ),
      ty: Math.round((70 + Math.floor(i / 8) * 110) * 20),
    };
  };
  for (let i = 0; i < count; i++) {
    tags.push(
      w.place({
        depth: i + 1,
        character: i % 2 ? 11 : 10,
        matrix: placed(i, 0),
        ...(i % 3 === 0 ? { colorTransform: { add: [40, 0, -30, 0] } } : {}),
      }),
    );
  }

  tags.push(w.showFrame());
  for (let frame = 1; frame < frames; frame++) {
    for (let i = count / 2; i < count; i++) {
      tags.push(w.place({ depth: i + 1, move: true, matrix: placed(i, frame) }));
    }

    tags.push(w.showFrame());
  }

  tags.push(w.end());
  return w.swf({ width: 520, height: 360, frameRate: 30, frameCount: frames, tags });
}

/**
 * Shapes placed normal, add, multiply, screen and lighten in turn, half
 * under a mask, a glowing sprite that stays still and a blurred one
 * multiplied between them; every other shape moves each frame.
 */
function blendMask(): Uint8Array {
  const colors = [0xcc3333, 0x33aa55, 0x3366cc, 0xddaa22, 0x8844cc];
  const modes = [1, 8, 3, 4, 5];
  const tags: Uint8Array[] = [
    w.backgroundColor(0x808080),
    ...colors.map((color, i) => ellipseShape(i + 1, 400, 300, color)),
    w.shape({
      id: 6,
      bounds: [0, 4000, 0, 7200],
      fills: [0x000000],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [0, 0] },
            { line: [4000, 0] },
            { line: [4000, 7200] },
            { line: [0, 7200] },
            { line: [0, 0] },
          ],
        },
      ],
    }),
    w.sprite(7, 1, [
      w.place({ depth: 1, character: 1 }),
      w.place({ depth: 2, character: 3, matrix: { tx: 300, ty: 200 } }),
      w.showFrame(),
      w.end(),
    ]),
  ];
  const shapes = 30;
  const frames = 120;
  const at = (i: number, frame: number) => ({
    tx: Math.round((40 + (i % 6) * 75 + (i % 2 ? Math.sin(frame / 7 + i) * 20 : 0)) * 20),
    ty: Math.round((40 + Math.floor(i / 6) * 60) * 20),
  });
  const depthOf = (i: number) => i + 3 + (i >= 10 ? 1 : 0) + (i >= 20 ? 1 : 0);
  // The mask clips the first 15 shapes' depths, the glowing sprite among them.
  tags.push(w.place({ depth: 2, character: 6, clipDepth: depthOf(14) }));
  for (let i = 0; i < shapes; i++) {
    tags.push(
      w.place({
        depth: depthOf(i),
        character: (i % colors.length) + 1,
        matrix: at(i, 0),
        blendMode: modes[i % modes.length],
      }),
    );
  }

  tags.push(
    w.place({
      depth: depthOf(9) + 1,
      character: 7,
      matrix: { tx: 3000, ty: 3000 },
      glows: [{ color: 0xffff00, blur: 8, strength: 2 }],
    }),
    w.place({
      depth: depthOf(19) + 1,
      character: 7,
      matrix: { tx: 7000, ty: 4000 },
      blendMode: 3,
      blurs: [6],
    }),
    w.showFrame(),
  );
  for (let frame = 1; frame < frames; frame++) {
    for (let i = 1; i < shapes; i += 2) {
      tags.push(w.place({ depth: depthOf(i), move: true, matrix: at(i, frame) }));
    }

    tags.push(w.showFrame());
  }

  tags.push(w.end());
  return w.swf({ width: 520, height: 360, frameRate: 30, frameCount: frames, tags });
}

/**
 * 24 depths whose shapes are replaced, removed and added again on the
 * timeline every frame, and six morphs whose ratio changes every frame,
 * each a shape the player has not drawn before.
 */
function swap(): Uint8Array {
  const kinds = 8;
  const tags: Uint8Array[] = [w.backgroundColor(0xffffff)];
  for (let k = 0; k < kinds; k++) {
    tags.push(
      w.shape({
        id: k + 1,
        bounds: [-500, 500, -500, 500],
        fills: [0x203040 + k * 0x1a1208],
        lines: [{ width: 20 + k * 10, color: 0x101010 }],
        paths: [
          {
            fill1: 1,
            line: 1,
            commands: k % 2 ? polygon(3 + k, 400) : ellipse(0, 0, 400, 260 + k * 20),
          },
        ],
      }),
    );
  }

  const morphs = 6;
  for (let m = 0; m < morphs; m++) {
    tags.push(
      w.morphShape({
        id: 20 + m,
        startBounds: [-500, 500, -500, 500],
        endBounds: [-700, 700, -700, 700],
        fills: [{ start: 0xff3366cc, end: 0xffcc6633 }],
        lines: [{ startWidth: 20, endWidth: 60, startColor: 0xff000000, endColor: 0xff336600 }],
        start: [{ fill0: 1, line: 1, commands: ellipse(0, 0, 400, 300 + m * 20) }],
        end: [ellipse(0, 0, 600 - m * 20, 500)],
      }),
    );
  }

  const depths = 24;
  const frames = 120;
  const state = new Array<number>(depths).fill(0);
  const at = (d: number, frame: number) => ({
    tx: Math.round((40 + (d % 6) * 80 + Math.sin(frame / 5 + d) * 10) * 20),
    ty: Math.round((40 + Math.floor(d / 6) * 70) * 20),
  });
  for (let frame = 0; frame < frames; frame++) {
    for (let d = 0; d < depths; d++) {
      const depth = d + 1;
      const op = (d * 7 + frame) % 5;
      const next = ((d + frame * 3) % kinds) + 1;
      if (state[d] === 0) {
        tags.push(w.place({ depth, character: next, matrix: at(d, frame) }));
        state[d] = next;
      } else if (op === 0) {
        tags.push(w.place({ depth, move: true, character: next, matrix: at(d, frame) }));
        state[d] = next;
      } else if (op === 1) {
        tags.push(w.remove(depth));
        state[d] = 0;
      } else {
        tags.push(w.place({ depth, move: true, matrix: at(d, frame) }));
      }
    }

    for (let m = 0; m < morphs; m++) {
      tags.push(
        w.place({
          depth: 100 + m,
          ...(frame === 0 ? { character: 20 + m } : { move: true }),
          ratio: (frame * 547 + m * 9973) % 65536,
          matrix: { tx: (60 + m * 80) * 20, ty: 330 * 20 },
        }),
      );
    }

    tags.push(w.showFrame());
  }

  tags.push(w.end());
  return w.swf({ width: 520, height: 360, frameRate: 30, frameCount: frames, tags });
}

/** Every case's SWF, by name: the site's demos built as the site builds them. */
function cases(): Map<string, Uint8Array> {
  const demos = buildDemos(`${here}out/draw-counts/`);
  const demo = (file: string) =>
    (demos.find((d) => d.file === file) as { bytes: Uint8Array }).bytes;
  return new Map([
    ["crowd", demo("crowd.swf")],
    ["bounce", demo("bounce.swf")],
    ["mixed-crowd", mixedCrowd()],
    ["blend-mask", blendMask()],
    ["swap", swap()],
  ]);
}

/** One play of `swf`: each count's mean over the counted frames, and the renderer that drew. */
async function play(
  swf: Uint8Array,
  gpu: boolean,
): Promise<{
  counts: Counts;
  warmUp: number;
  textures: number;
  renderer: string;
}> {
  // As a host that draws blend modes makes its renderer (useBackBuffer), on the page's frame clock.
  const frames = 1 + WARM_UP_MOST + COUNTED;
  const result = await benchPlayer(
    swf,
    frames,
    gpu,
    true,
    0,
    -1,
    false,
    1,
    false,
    false,
    true,
    undefined,
    undefined,
    0,
    undefined,
    1,
    false,
    undefined,
    true,
    true,
    true,
  );
  if (result.error) {
    throw new Error(result.error);
  }

  // The first frame the warm-up may end on with STEADY frames before it free of new buffers.
  const meters = result.meters;
  let warmUp = WARM_UP_MOST;
  let quiet = 0;
  for (let i = 0; i < WARM_UP_MOST; i++) {
    quiet = meters[i].bufferData ? 0 : quiet + 1;
    if (i + 1 >= WARM_UP && quiet >= STEADY) {
      warmUp = i + 1;
      break;
    }
  }

  const counted = meters.slice(warmUp, warmUp + COUNTED);
  assert.equal(counted.length, COUNTED);
  const textures = Math.max(0, ...result.meters.map((m) => m.batchTexturesMost ?? 0));
  if (textures >= MOST_TEXTURES) {
    throw new Error(
      `a batch drew with ${textures} textures: a GPU with more units would batch otherwise`,
    );
  }

  const counts: Counts = {};
  for (const key of [...KEYS, ...BUFFERS]) {
    let sum = 0;
    for (const reading of counted) {
      sum += reading[key] ?? 0;
    }

    counts[key] = Math.round((sum / COUNTED) * 100) / 100;
  }

  return { counts, warmUp, textures, renderer: result.renderer };
}

const args = process.argv.slice(2);
const update = args.includes("--update");
const gpu = args.includes("--gpu");
const runsAt = args.indexOf("--runs");
const runs = runsAt >= 0 ? Number(args[runsAt + 1]) : 1;
const writeAt = args.indexOf("--write-swfs");
const wanted = args.filter(
  (a, i) =>
    !a.startsWith("--") && (runsAt < 0 || i !== runsAt + 1) && (writeAt < 0 || i !== writeAt + 1),
);
if (writeAt >= 0) {
  const dir = args[writeAt + 1];
  mkdirSync(dir, { recursive: true });
  for (const [name, swf] of cases()) {
    writeFileSync(`${dir}/${name}.swf`, swf);
  }

  process.exit(0);
}

// The libraries bounce plays on, served to the page.
libraryAbcs();
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, Counts>;
const failures: string[] = [];
const lower: string[] = [];
const measured: Record<string, Counts> = { ...baseline };
for (const [name, swf] of cases()) {
  if (wanted.length > 0 && !wanted.includes(name)) {
    continue;
  }

  let first: Counts | null = null;
  for (let run = 0; run < runs; run++) {
    const { counts, warmUp, textures, renderer } = await play(swf, gpu);
    const shown = KEYS.map((k) => `${k} ${counts[k]}`).join(", ");
    const buffers = `bufferData ${counts.bufferData} (${Math.round(counts.bufferDataBytes / 1024)} KB), copyBufferSubData ${counts.copyBufferSubData} (${Math.round(counts.copyBufferSubDataBytes / 1024)} KB)`;
    console.log(
      `draw-counts: ${name}: ${shown}; ${buffers} a frame after ${warmUp} of warm-up; batches of ${textures} textures at most (${renderer})`,
    );
    if (first) {
      for (const key of KEYS) {
        if (counts[key] !== first[key]) {
          failures.push(`${name}: ${key} ${counts[key]} in run ${run + 1}, ${first[key]} in run 1`);
        }
      }
    } else {
      first = counts;
    }
  }

  const counts = first as Counts;
  measured[name] = Object.fromEntries(KEYS.map((k) => [k, counts[k]]));
  const was = baseline[name];
  if (update) {
    continue;
  }

  if (!was) {
    failures.push(`${name}: not in draw-counts.json; run with --update to add it`);
    continue;
  }

  for (const key of KEYS) {
    if (counts[key] > (was[key] ?? 0)) {
      failures.push(`${name}: ${key} ${counts[key]} a frame, above the baseline's ${was[key]}`);
    } else if (counts[key] < (was[key] ?? 0)) {
      lower.push(`${name}: ${key} ${counts[key]}, ${was[key]} in the baseline`);
    }
  }
}

if (update) {
  writeFileSync(baselinePath, `${JSON.stringify(measured, null, 2)}\n`);
  console.log(`draw-counts: wrote ${baselinePath}`);
}

if (lower.length > 0) {
  console.log(
    `draw-counts: below the baseline, which --update lowers to them:\n  ${lower.join("\n  ")}`,
  );
}

assert.deepEqual(failures, [], "draw counts above their baseline, or unstable between runs");
console.log("draw-counts: ok");
