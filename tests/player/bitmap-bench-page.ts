import { Convolver } from "@swf2es/native/bitmap";
import { BitmapStore } from "../../packages/player/dist/bitmap/bitmap.js";
import { applyFilter } from "../../packages/player/dist/bitmap/filters.js";
import { filterDefaults } from "../../packages/player/dist/display/filters.js";

const engines = { native: new Convolver() };
const modes = ["js", "native"] as const;
type Mode = (typeof modes)[number];
const cases = [
  { size: 1, cols: 3, reps: 600 },
  { size: 8, cols: 1, reps: 160 },
  { size: 64, cols: 3, reps: 16 },
  { size: 512, cols: 3, reps: 2 },
  { size: 1024, cols: 3, reps: 1 },
  { size: 512, cols: 5, reps: 2 },
  { size: 1024, cols: 5, reps: 1 },
  { size: 1024, roi: 32, cols: 5, reps: 16 },
].map((c) => {
  const source = new BitmapStore(c.size, c.size, true, 0);
  let seed = 7149;
  for (let i = 0; i < source.pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const alpha = i % 3 ? 255 : seed >>> 24;
    source.pixels[i] =
      (alpha << 24) |
      (((((seed >>> 16) & 255) * alpha + 127) / 255) << 16) |
      (((((seed >>> 8) & 255) * alpha + 127) / 255) << 8) |
      (((seed & 255) * alpha + 127) / 255);
  }

  const size = c.roi ?? c.size;
  const dest = new BitmapStore(size, size, true, 0);
  const rect = {
    x: c.roi ? (c.size - size) >> 1 : 0,
    y: c.roi ? (c.size - size) >> 1 : 0,
    width: size,
    height: size,
  };
  const filter = {
    ...filterDefaults("convolution"),
    matrixX: c.cols,
    matrixY: c.cols,
    matrix: Array.from({ length: c.cols * c.cols }, (_, k) =>
      c.cols === 5 ? ((k % 7) - 2.5) / 9 : 1,
    ),
    divisor: c.cols === 5 ? 1.75 : c.cols * c.cols,
    bias: c.cols === 5 ? 7.25 : 0,
    alpha: 0.5,
    color: 0x7030a0,
    clamp: true,
    preserveAlpha: true,
  };
  return {
    ...c,
    name: `${c.size}x${c.size}/${c.cols}x${c.cols}${c.roi ? "/roi32" : ""}`,
    source,
    dest,
    rect,
    filter,
  };
});

let calls = 0;
function apply(c: (typeof cases)[number], mode: Mode): void {
  const hook = mode === "js" ? null : engines[mode].convolve;
  applyFilter(c.dest, c.source, c.rect, 0, 0, c.filter, null, hook);
}

function bitmapBench(phase: string, round = 0) {
  if (phase === "warm") {
    for (const c of cases) {
      apply(c, "js");
      const expected = c.dest.pixels.slice();
      for (const mode of ["native"] as const) {
        const output = engines[mode].convolve(c.source, c.rect, c.filter, true);
        if (!output) {
          throw Error(`native benchmark unavailable: ${mode}`);
        }

        for (let i = 0; i < Math.max(5, c.reps); i++) {
          apply(c, mode);
        }

        if (!c.dest.pixels.every((p, i) => p === expected[i])) {
          throw Error(`pixel mismatch: ${c.name}/${mode}`);
        }
      }
    }

    return { exact: true, userAgent: navigator.userAgent };
  }

  if (phase === "round") {
    const result = [];
    for (let k = 0; k < cases.length; k++) {
      const c = cases[(k + round) % cases.length];
      for (let j = 0; j < modes.length; j++) {
        const mode = modes[(j + round) % modes.length];
        const started = performance.now();
        for (let i = 0; i < c.reps; i++) {
          apply(c, mode);
          calls++;
        }

        result.push({ workload: c.name, round, mode, ms: (performance.now() - started) / c.reps });
      }
    }

    return result;
  }

  if (phase === "dispose") {
    const capacities = Object.fromEntries(
      Object.entries(engines).map(([name, e]) => [name, e.capacity]),
    );
    for (const e of Object.values(engines)) {
      e.dispose();
    }
    cases.length = 0;
    return { calls, capacities, disposed: Object.values(engines).every((e) => e.capacity === 0) };
  }

  throw Error("unknown benchmark phase");
}

Object.assign(globalThis, { bitmapBench });
