// Draws random bitmaps into random BitmapData with two builds of the player
// and compares every pixel: for a change to drawBitmap or copyPixels that
// should draw what it drew before, faster. Each case draws a premultiplied
// source, or the store itself, through a turned, scaled, mirrored, moved or
// quarter-pixel matrix, with or without a colour transform, smoothing and a
// clip, in every blend mode and layer, or copies pixels with merge and an
// alpha bitmap; opaque sources sometimes hold alpha. A case that differs is
// printed with what it did.
//
//   node tests/bench/bitmap-draws.ts <checkout A> <checkout B> [cases, 6000] [seed, 1] [--big]
//
// Each checkout must be built (packages/player/dist). --big draws half the
// cases up to 400 by 300 pixels, where the row passes keep their buffers.
import { resolve } from "node:path";

const args = process.argv.slice(2);
const big = args.includes("--big");
const [dirA, dirB, casesArg, seedArg] = args.filter((a) => a !== "--big");
if (!dirA || !dirB) {
  console.error("usage: node tests/bench/bitmap-draws.ts <checkout A> <checkout B> [cases] [seed]");
  process.exit(2);
}

interface Build {
  ops: typeof import("../../packages/player/dist/bitmap/ops.js");
  bitmap: typeof import("../../packages/player/dist/bitmap/bitmap.js");
}

async function load(dir: string): Promise<Build> {
  const dist = `${resolve(dir)}/packages/player/dist/bitmap`;
  return { ops: await import(`${dist}/ops.js`), bitmap: await import(`${dist}/bitmap.js`) };
}

const builds = [await load(dirA), await load(dirB)];
const cases = Number(casesArg ?? 6000);
let seed = Number(seedArg ?? 1) >>> 0;
const random = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 2 ** 32;
};
const below = (n: number) => Math.floor(random() * n);
const pixel = () => {
  const r = random();
  const a = r < 0.3 ? 255 : r < 0.5 ? 0 : below(256);
  return ((a << 24) | (below(256) << 16) | (below(256) << 8) | below(256)) >>> 0;
};

const MODES = [
  "normal",
  "layer",
  "multiply",
  "screen",
  "lighten",
  "darken",
  "difference",
  "add",
  "subtract",
  "invert",
  "overlay",
  "hardlight",
  "alpha",
  "erase",
];

function matrix(): { a: number; b: number; c: number; d: number; tx: number; ty: number } {
  switch (below(5)) {
    case 0:
      return { a: 1, b: 0, c: 0, d: 1, tx: below(30) - 10, ty: below(30) - 10 };
    case 1: {
      const [a, d] = [0.2 + random() * 3, 0.2 + random() * 3];
      return { a, b: 0, c: 0, d, tx: random() * 30 - 10, ty: random() * 30 - 10 };
    }
    case 2: {
      // Turned a quarter at a time, scaled, at quarter and eighth pixels.
      const k = [0.5, 1, 2, 4, 0.25, 3][below(6)];
      const [cos, sin] = [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ][below(4)];
      const tx = below(160) / 4 - 10;
      const ty = below(160) / 8 - 10;
      return { a: cos * k, b: sin * k, c: -sin * k, d: cos * k, tx, ty };
    }
    default: {
      const turn = random() * 6.3;
      const k = 0.3 + random() * 2;
      const mirror = random() < 0.2 ? -1 : 1;
      const [tx, ty] = [random() * 40 - 10, random() * 40 - 10];
      const [cos, sin] = [Math.cos(turn) * k, Math.sin(turn) * k];
      return { a: cos * mirror, b: sin, c: -sin, d: cos, tx, ty };
    }
  }
}

let differ = 0;
for (let c = 0; c < cases; c++) {
  const large = big && random() < 0.5;
  const dw = 1 + below(large ? 400 : 40);
  const dh = 1 + below(large ? 300 : 40);
  const sw = 1 + below(large ? 300 : 30);
  const sh = 1 + below(large ? 300 : 30);
  const destTransparent = random() < 0.7;
  const sourceTransparent = random() < 0.7;
  const dest = Array.from({ length: dw * dh }, pixel);
  const from = Array.from({ length: sw * sh }, pixel);
  const self = random() < 0.1;
  // Drawn into itself, mostly moved a little, so that a pixel reads others the draw writes.
  const m =
    self && random() < 0.7
      ? { a: 1, b: 0, c: 0, d: 1, tx: below(13) / 2 - 3, ty: below(13) / 2 - 3 }
      : matrix();
  const ct =
    random() < 0.5
      ? null
      : {
          rMul: random() * 2,
          gMul: random(),
          bMul: random() * 1.5,
          aMul: random() * 1.2,
          rAdd: below(200) - 100,
          gAdd: below(100) - 50,
          bAdd: 0,
          aAdd: random() < 0.5 ? -below(120) : below(60),
        };
  const mode = MODES[below(MODES.length)];
  const clip =
    random() < 0.3 ? { x: below(20), y: below(20), width: below(30), height: below(30) } : null;
  const smooth = random() < 0.5;
  const rows = random() < 0.5;
  const layer = [null, "bitmap", "drawing"][below(3)] as "bitmap" | "drawing" | null;
  const holds = !sourceTransparent && random() < 0.4;
  const copy = c % 3 === 0;
  const copyArgs = {
    rect: { x: below(sw) - 3, y: below(sh) - 3, width: below(sw + 5), height: below(sh + 5) },
    dx: below(dw) - 5,
    dy: below(dh) - 5,
    merge: random() < 0.5,
    alpha: random() < 0.3,
    ax: below(4),
    ay: below(4),
  };

  const results = builds.map(({ ops, bitmap }) => {
    const store = (
      width: number,
      height: number,
      transparent: boolean,
      pixels: number[],
      hold = false,
    ) => {
      const s = new bitmap.BitmapStore(width, height, transparent, 0);
      for (let i = 0; i < pixels.length; i++) {
        s.pixels[i] = bitmap.premultiply(
          transparent || hold ? pixels[i] : (pixels[i] | 0xff000000) >>> 0,
        );
      }

      s.holdsAlpha = hold;
      return s;
    };
    const d = store(dw, dh, destTransparent, dest);
    const s = self ? d : store(sw, sh, sourceTransparent, from, holds);
    if (copy) {
      const { rect, dx, dy, merge, alpha, ax, ay } = copyArgs;
      d.copyPixels(s, rect, dx, dy, merge, alpha ? s : null, ax, ay);
    } else {
      ops.drawBitmap(d, s, m, ct, mode, clip, smooth, rows, layer);
    }

    return [...d.pixels, d.holdsAlpha ? 1 : 0];
  });

  const [a, b] = results;
  const at = a.findIndex((v, i) => v !== b[i]);
  if (at >= 0) {
    differ++;
    if (differ <= 10) {
      const what = copy
        ? { copy: copyArgs, self }
        : { m, ct, mode, clip, smooth, self, rows, layer, holds };
      console.log(`case ${c} differs at ${at}: ${a[at]} against ${b[at]}`, JSON.stringify(what));
    }
  }
}

console.log(differ === 0 ? `the same over ${cases} cases` : `${differ} of ${cases} cases differ`);
process.exit(differ === 0 ? 0 : 1);
