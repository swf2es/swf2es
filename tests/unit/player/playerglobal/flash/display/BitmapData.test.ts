// BitmapData's natives and the filters' fed numbers of every kind, NaN,
// Infinity, past int's range and the edges of adl's limits, from a fixed
// seed: an AS3 error is as adl refuses them, but none may throw a JS error,
// which would end the player, nor make a buffer of a size the input
// chose.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { libraryAbcs } from "../../../../../player/libraries.ts";

const out = fileURLToPath(new URL("../../../../out/player-fuzz/", import.meta.url));
const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);
const s = new Scripting(await createCodegen(wasm), { print: () => {} });
await s.loadLibraries(libraryAbcs(`${out}libraries/`));
const rt = s.rt;

// A short run from seed 1; SWF2ES_FUZZ_STEPS and SWF2ES_FUZZ_SEED run it longer, or from another,
// and SWF2ES_FUZZ_LOG=1 prints each step before it runs, for one that never returns.
const steps = Number(process.env.SWF2ES_FUZZ_STEPS ?? 2000);
const first = Number(process.env.SWF2ES_FUZZ_SEED ?? 1) >>> 0;
const log = process.env.SWF2ES_FUZZ_LOG === "1";
let seed = first;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)];

const SPECIAL = [
  Number.NaN,
  Infinity,
  -Infinity,
  0,
  -0,
  1,
  -1,
  0.5,
  1.5,
  2.5,
  -0.5,
  2 ** 29,
  -(2 ** 29),
  2 ** 30,
  -(2 ** 30),
  2 ** 30 - 1,
  -(2 ** 30 - 1),
  2 ** 31,
  -(2 ** 31),
  2 ** 31 - 1,
  2 ** 32,
  2 ** 32 - 1,
  1e20,
  -1e20,
  1e308,
  -1e308,
  5e-324,
  2 ** 53,
  0x7fffffff,
  106e6,
  108e6,
];
const num = (): number => {
  const r = rand();
  if (r < 0.45) {
    return pick(SPECIAL);
  }

  if (r < 0.8) {
    return Math.floor(rand() * 60) - 20;
  }

  return (rand() - 0.3) * 100;
};
const small = (): number => (rand() < 0.85 ? Math.floor(rand() * 30) - 5 : num());

const cls = (n: string) => rt.classNamed(n);
const make = (n: unknown, ...a: unknown[]) =>
  rt.construct(typeof n === "string" ? cls(n) : n, ...a);
const call = (o: unknown, m: string, ...a: unknown[]) => rt.callProperty(o, rt.publicName(m), ...a);
const get = (o: unknown, m: string) => rt.getProperty(o, rt.publicName(m));
const set = (o: unknown, m: string, v: unknown) => rt.setProperty(o, rt.publicName(m), v);

const rect = () =>
  rand() < 0.05 ? null : make("flash.geom::Rectangle", num(), num(), num(), num());
const point = () => (rand() < 0.05 ? null : make("flash.geom::Point", num(), num()));
const matrix = () =>
  rand() < 0.1
    ? null
    : make(
        "flash.geom::Matrix",
        rand() < 0.5 ? 1 : num(),
        rand() < 0.7 ? 0 : num(),
        rand() < 0.7 ? 0 : num(),
        rand() < 0.5 ? 1 : num(),
        num(),
        num(),
      );
const ct = () =>
  rand() < 0.1
    ? null
    : make("flash.geom::ColorTransform", num(), num(), num(), num(), num(), num(), num(), num());

const bitmaps: unknown[] = [];
const newBitmap = () => {
  const w = rand() < 0.1 ? num() : Math.floor(rand() * 24) + 1;
  const h = rand() < 0.1 ? num() : Math.floor(rand() * 24) + 1;
  // A size adl makes, of up to 536625144 pixels, would be made here too: those
  // past a few million stand in for the ones it refuses.
  const pixels = (w | 0) * (h | 0);
  const made = pixels > 4e6 && pixels <= 536625144 && (w | 0) > 0 && (h | 0) > 0;
  return make("flash.display::BitmapData", made ? 1e20 : w, h, rand() < 0.5, num());
};
for (let i = 0; i < 6; i++) {
  bitmaps.push(make("flash.display::BitmapData", 8 + i * 3, 5 + i * 2, i % 2 === 0, 0xff336699));
}
const bd = () => pick(bitmaps);

const arr = (n: number, f: () => unknown) => {
  const a = make("Array");
  for (let i = 0; i < n; i++) {
    call(a, "push", f());
  }
  if (rand() < 0.1) {
    set(a, "length", pick([1e6, 2 ** 32 - 1, 100]));
  }
  return a;
};
const bool = () => (rand() < 0.5 ? rand() < 0.5 : num());
const quality = () => (rand() < 0.7 ? Math.floor(rand() * 4) : num());
const filter = () => {
  switch (Math.floor(rand() * 9)) {
    case 0:
      return make("flash.filters::BlurFilter", num(), num(), quality());
    case 1:
      return make(
        "flash.filters::GlowFilter",
        num(),
        num(),
        num(),
        num(),
        num(),
        quality(),
        bool(),
        bool(),
      );
    case 2:
      return make(
        "flash.filters::DropShadowFilter",
        num(),
        num(),
        num(),
        num(),
        num(),
        num(),
        num(),
        quality(),
        bool(),
        bool(),
        bool(),
      );
    case 3:
      return make(
        "flash.filters::BevelFilter",
        num(),
        num(),
        num(),
        num(),
        num(),
        num(),
        num(),
        num(),
        num(),
        quality(),
        pick(["inner", "outer", "full", "x"]),
        bool(),
      );
    case 4:
      return make(
        "flash.filters::ColorMatrixFilter",
        arr(rand() < 0.8 ? 20 : Math.floor(rand() * 40), () => (rand() < 0.3 ? num() : 0)),
      );
    case 5: {
      const cols = rand() < 0.8 ? Math.floor(rand() * 5) : num();
      const rows = rand() < 0.8 ? Math.floor(rand() * 5) : num();
      return make(
        "flash.filters::ConvolutionFilter",
        cols,
        rows,
        arr(Math.floor(rand() * 30), num),
        num(),
        num(),
        bool(),
        bool(),
        num(),
        num(),
      );
    }
    case 6:
      return make(
        "flash.filters::DisplacementMapFilter",
        rand() < 0.2 ? null : bd(),
        point(),
        num(),
        num(),
        num(),
        num(),
        pick(["wrap", "clamp", "ignore", "color", "x"]),
        num(),
        num(),
      );
    case 7: {
      const n = Math.floor(rand() * 20);
      return make(
        "flash.filters::GradientGlowFilter",
        num(),
        num(),
        arr(n, num),
        arr(rand() < 0.8 ? n : Math.floor(rand() * 20), num),
        arr(rand() < 0.8 ? n : Math.floor(rand() * 20), num),
        num(),
        num(),
        num(),
        quality(),
        pick(["inner", "outer", "full", "x"]),
        bool(),
      );
    }
    default: {
      const n = Math.floor(rand() * 20);
      return make(
        "flash.filters::GradientBevelFilter",
        num(),
        num(),
        arr(n, num),
        arr(rand() < 0.8 ? n : Math.floor(rand() * 20), num),
        arr(rand() < 0.8 ? n : Math.floor(rand() * 20), num),
        num(),
        num(),
        num(),
        quality(),
        pick(["inner", "outer", "full", "x"]),
        bool(),
      );
    }
  }
};

const bytes = () => {
  const b = make("flash.utils::ByteArray");
  const n = Math.floor(rand() * 400);
  for (let i = 0; i < n; i++) {
    call(b, "writeByte", Math.floor(rand() * 256));
  }
  // A ByteArray's own position as far as 1e9 grows it as far in adl too.
  if (rand() < 0.5) {
    set(b, "position", Math.floor(rand() * (n + 20)));
  }
  return b;
};

const vector = () => {
  const v = make(rt.resolve(rt.vector("uint")));
  const n = Math.floor(rand() * 600);
  for (let i = 0; i < n; i++) {
    call(v, "push", Math.floor(rand() * 2 ** 32));
  }
  return v;
};

type Op = [string, () => unknown];
const ops: Op[] = [
  ["ctor", () => bitmaps.push(newBitmap())],
  ["getPixel", () => call(bd(), "getPixel", num(), num())],
  ["getPixel32", () => call(bd(), "getPixel32", num(), num())],
  ["setPixel", () => call(bd(), "setPixel", num(), num(), num())],
  ["setPixel32", () => call(bd(), "setPixel32", num(), num(), num())],
  ["fillRect", () => call(bd(), "fillRect", rect(), num())],
  [
    "copyPixels",
    () =>
      call(
        bd(),
        "copyPixels",
        bd(),
        rect(),
        point(),
        rand() < 0.5 ? null : bd(),
        point(),
        rand() < 0.5,
      ),
  ],
  ["applyFilter", () => call(bd(), "applyFilter", bd(), rect(), point(), filter())],
  ["generateFilterRect", () => call(bd(), "generateFilterRect", rect(), filter())],
  ["getPixels", () => call(bd(), "getPixels", rect())],
  ["copyPixelsToByteArray", () => call(bd(), "copyPixelsToByteArray", rect(), bytes())],
  ["setPixels", () => call(bd(), "setPixels", rect(), bytes())],
  ["getVector", () => call(bd(), "getVector", rect())],
  ["setVector", () => call(bd(), "setVector", rect(), vector())],
  [
    "encode",
    () =>
      call(
        bd(),
        "encode",
        rect(),
        make("flash.display::PNGEncoderOptions", rand() < 0.5),
        rand() < 0.5 ? null : bytes(),
      ),
  ],
  ["noise", () => call(bd(), "noise", num(), num(), num(), num(), rand() < 0.5)],
  [
    "copyChannel",
    () =>
      call(
        bd(),
        "copyChannel",
        bd(),
        rect(),
        point(),
        pick([1, 2, 4, 8, num()]),
        pick([1, 2, 4, 8, num()]),
      ),
  ],
  [
    "perlinNoise",
    () => {
      const offs = make("Array");
      for (let i = 0; i < 3; i++) {
        call(offs, "push", point());
      }
      return call(
        bd(),
        "perlinNoise",
        num(),
        num(),
        rand() < 0.8 ? Math.floor(rand() * 4) : num(),
        num(),
        rand() < 0.5,
        rand() < 0.5,
        num(),
        rand() < 0.5,
        offs,
      );
    },
  ],
  [
    "paletteMap",
    () => {
      const t = () => {
        if (rand() < 0.5) {
          return null;
        }
        const a = make("Array");
        for (let i = 0; i < Math.floor(rand() * 300); i++) {
          call(a, "push", num());
        }
        return a;
      };
      return call(bd(), "paletteMap", bd(), rect(), point(), t(), t(), t(), t());
    },
  ],
  ["compare", () => call(bd(), "compare", bd())],
  ["colorTransform", () => call(bd(), "colorTransform", rect(), ct())],
  ["merge", () => call(bd(), "merge", bd(), rect(), point(), num(), num(), num(), num())],
  ["scroll", () => call(bd(), "scroll", num(), num())],
  [
    "threshold",
    () =>
      call(
        bd(),
        "threshold",
        bd(),
        rect(),
        point(),
        pick(["<", "<=", ">", ">=", "==", "!="]),
        num(),
        num(),
        num(),
        rand() < 0.5,
      ),
  ],
  ["getColorBoundsRect", () => call(bd(), "getColorBoundsRect", num(), num(), rand() < 0.5)],
  ["floodFill", () => call(bd(), "floodFill", num(), num(), num())],
  ["histogram", () => call(bd(), "histogram", rand() < 0.2 ? null : rect())],
  [
    "hitTest",
    () => {
      const r = rand();
      const second = r < 0.33 ? point() : r < 0.66 ? rect() : bd();
      return call(bd(), "hitTest", point(), num(), second, point(), num());
    },
  ],
  [
    "pixelDissolve",
    () =>
      call(
        bd(),
        "pixelDissolve",
        bd(),
        rect(),
        point(),
        num(),
        rand() < 0.5 ? small() : num(),
        num(),
      ),
  ],
  [
    "draw",
    () =>
      call(
        bd(),
        "draw",
        rand() < 0.8 ? bd() : make("flash.display::Bitmap", bd()),
        matrix(),
        ct(),
        pick([null, "normal", "multiply", "add", "erase", "alpha", "layer", "invert"]),
        rect(),
        rand() < 0.5,
      ),
  ],
  ["clone", () => call(bd(), "clone")],
  ["rect", () => get(bd(), "rect")],
  [
    "bitmap",
    () => {
      const b = make("flash.display::Bitmap", bd(), "auto", rand() < 0.5);
      set(b, "x", num());
      set(b, "scaleX", num());
      set(b, "rotation", num());
      set(b, "scrollRect", rect());
      return call(b, "getBounds", b);
    },
  ],
  [
    "beginBitmapFill",
    () => {
      const sh = make("flash.display::Shape");
      const g = get(sh, "graphics");
      call(g, "beginBitmapFill", bd(), matrix(), rand() < 0.5, rand() < 0.5);
      call(g, "drawRect", num(), num(), num(), num());
      call(g, "lineBitmapStyle", bd(), matrix());
      call(g, "lineTo", num(), num());
      return call(sh, "getBounds", sh);
    },
  ],
  [
    "dispose",
    () => {
      if (rand() < 0.1 && bitmaps.length > 4) {
        call(bitmaps.splice(Math.floor(rand() * bitmaps.length), 1)[0], "dispose");
      }
    },
  ],
];

test("no BitmapData native or filter throws a JS error or makes a buffer the input sized", () => {
  const errors = new Map<string, string>();
  const grown: string[] = [];
  for (let i = 0; i < steps; i++) {
    const [name, fn] = pick(ops);
    // Each step's state is what the steps before it left: the run to it reproduces it.
    const again = `SWF2ES_FUZZ_SEED=${first} SWF2ES_FUZZ_STEPS=${i + 1}`;
    if (log) {
      console.log(`${again} ${name}`);
    }

    const before = process.memoryUsage().arrayBuffers;
    try {
      fn();
    } catch (e) {
      if (e instanceof Error && !errors.has(`${name}: ${e.message}`)) {
        errors.set(`${name}: ${e.message}`, `${again}: ${e.stack?.split("\n")[1]}`);
      }
    }

    // A blur of 255 by 15 passes works on some 4,000 pixels a side; past
    // that only what the input asked for could have grown it.
    const growth = process.memoryUsage().arrayBuffers - before;
    if (growth > 1e9) {
      grown.push(`${name}, ${again}: ${Math.round(growth / 1e6)} MB`);
    }

    if (bitmaps.length > 40) {
      bitmaps.splice(6, bitmaps.length - 20);
    }
  }

  assert.deepEqual(
    [...errors].map(([k, v]) => `${k} (${v})`),
    [],
  );
  assert.deepEqual(grown, []);
});

test("pixelDissolve takes its seed as the int it is declared, NaN as 0", () => {
  const b = make("flash.display::BitmapData", 6, 5, true, 0);
  const r = make("flash.geom::Rectangle", 0, 0, 6, 5);
  const p = make("flash.geom::Point", 0, 0);
  for (const seed of [Number.NaN, Infinity, 2 ** 32 + 3]) {
    const zero = make("flash.display::BitmapData", 6, 5, true, 0);
    assert.equal(
      call(b, "pixelDissolve", b, r, p, seed, 7, 0xff00ff00),
      call(zero, "pixelDissolve", zero, r, p, seed === 2 ** 32 + 3 ? 3 : 0, 7, 0xff00ff00),
    );
  }
});

test("pixelDissolve's answers past the states, at count 0 and for a rect a pixel high are AVM1's", () => {
  // adl (the dissolve-noise case): a 5 by 5 source into a 5 by 5 destination at (1, 1).
  const p = make("flash.geom::Point", 1, 1);
  const answer = (w: number, h: number, seed: number, count: number) => {
    const dest = make("flash.display::BitmapData", 5, 5, true, 0xaabbccdd);
    const src = make("flash.display::BitmapData", 5, 5, true, 0x12345678);
    const rect = make("flash.geom::Rectangle", 0, 0, w, h);
    return call(dest, "pixelDissolve", src, rect, p, seed, count, 0);
  };
  assert.deepEqual(
    [answer(2, 2, 100, 1), answer(2, 2, 7, 1), answer(2, 2, -1, 1), answer(2, 2, 100, 0)],
    [1, 0, 2, 100],
  );
  assert.deepEqual([answer(3, 3, 100, 1), answer(2, 1, -2, 3), answer(2, 2, 0, 0)], [0, -2, 3]);
});
