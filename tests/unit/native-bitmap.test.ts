import assert from "node:assert/strict";
import { test } from "node:test";
import { Convolver } from "@swf2es/native/bitmap";
import { binary } from "../../packages/native/dist/bitmap/binary.js";
import { BitmapStore } from "../../packages/player/dist/bitmap/bitmap.js";
import { applyFilter } from "../../packages/player/dist/bitmap/filters.js";
import { filterDefaults } from "../../packages/player/dist/display/filters.js";

const filter = () => ({
  ...filterDefaults("convolution"),
  matrixX: 3,
  matrixY: 3,
  matrix: [1, 1, 1, 1, 1, 1, 1, 1, 1],
  divisor: 9,
  bias: 0,
  alpha: 0.5,
  color: 0x7030a0,
  clamp: true,
  preserveAlpha: true,
});
const area = { x: 0, y: 0, width: 16, height: 16 };
const wasm = (
  globalThis as unknown as {
    WebAssembly: {
      Module: typeof WebAssembly.Module & {
        new (bytes: ArrayBufferView | ArrayBuffer): WebAssembly.Module;
      };
      Instance: new (module: WebAssembly.Module) => WebAssembly.Instance;
      RuntimeError: new (message: string) => Error;
    };
  }
).WebAssembly;

test("native convolution exactly matches JS through clipping, writing and self-filtering", () => {
  let seed = 89371;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)];
  const special = [NaN, Infinity, -Infinity, -0, 0, 1e-300, 1e300, -1e300, 1 / 3, -1 / 3];
  const number = (n: number) => (random() < 0.1 ? pick(special) : (random() * 2 - 1) * n);
  const owners = [new Convolver()];
  let calls = 0;
  for (let i = 0; i < 5000; i++) {
    const sw = 1 + ((random() * 17) | 0),
      sh = 1 + ((random() * 13) | 0);
    const dw = 1 + ((random() * 21) | 0),
      dh = 1 + ((random() * 18) | 0);
    const cols = pick([0, 1, 2, 3, 3, 3, 5, 7, 15]);
    const rows = random() < 0.8 ? cols : pick([0, 1, 2, 3, 5, 15]);
    const f = {
      ...filter(),
      matrixX: cols,
      matrixY: rows,
      matrix: Array.from(
        { length: random() < 0.2 ? (random() * cols * rows) | 0 : cols * rows },
        () => (random() < 0.6 ? ((random() * 9) | 0) - 4 : number(20)),
      ),
      preserveAlpha: random() < 0.5,
      clamp: random() < 0.5,
      divisor: pick([0, -0, 1, 2, Math.fround(1.1), Math.fround(2.0001), 3, 9, 100, number(20)]),
      bias: random() < 0.3 ? number(300) : 0,
      alpha: random() < 0.2 ? number(3) : random(),
      color: (random() * 2 ** 32) >>> 0,
    };
    const pixels = Uint32Array.from({ length: sw * sh }, () =>
      pick([0, 0xffffffff, 0x80302010, (random() * 2 ** 32) >>> 0]),
    );
    const destination = Uint32Array.from({ length: dw * dh }, () => (random() * 2 ** 32) >>> 0);
    const transparent = random() < 0.5,
      destTransparent = random() < 0.5,
      alias = random() < 0.2;
    const far = i % 53 === 0 ? pick([-1e9, 1e9]) : 0;
    const rect = {
      x: far + ((random() * (sw + 8)) | 0) - 4,
      y: ((random() * (sh + 8)) | 0) - 4,
      width: ((random() * (sw + 6)) | 0) - 1,
      height: ((random() * (sh + 6)) | 0) - 1,
    };
    const dx = ((random() * 8) | 0) - 3,
      dy = ((random() * 8) | 0) - 3;
    const run = (owner: Convolver | null) => {
      const source = new BitmapStore(sw, sh, transparent, 0);
      source.pixels.set(pixels);
      const dest = alias ? source : new BitmapStore(dw, dh, destTransparent, 0);
      if (!alias) {
        dest.pixels.set(destination);
      }

      const result = applyFilter(
        dest,
        source,
        rect,
        dx,
        dy,
        f,
        null,
        owner
          ? (...args) => {
              calls++;
              const out = owner.convolve(...args);
              assert.ok(out, `unexpected rejection in case ${i}`);
              return out;
            }
          : null,
      );
      return { result, version: dest.version, pixels: dest.pixels, source: source.pixels };
    };
    const expected = run(null);
    for (const owner of owners) {
      assert.deepEqual(run(owner), expected, `case ${i}, seed 89371`);
    }
  }

  assert.ok(calls > 3000, "differential cases must actually invoke the native kernels");
  for (const owner of owners) {
    owner.dispose();
    assert.equal(owner.capacity, 0);
  }
});

test("a rect convolved in bands of rows matches JS across the bands' seams", () => {
  // Wide enough that the rect takes several calls; the rows a band's kernel
  // reaches above and below come from its neighbours.
  const sw = 700,
    sh = 600;
  const source = new BitmapStore(sw, sh, true, 0);
  let seed = 4127;
  for (let i = 0; i < source.pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const alpha = i % 5 ? 255 : seed >>> 24;
    source.pixels[i] =
      ((alpha << 24) | (((((seed >>> 16) & 255) * alpha) / 255) << 16) | (seed & alpha)) >>> 0;
  }

  const owners = [new Convolver()];
  for (const clamp of [true, false]) {
    const f = {
      ...filter(),
      matrixX: 5,
      matrixY: 7,
      matrix: Array.from({ length: 35 }, (_, k) => ((k % 6) - 2) / 3),
      divisor: 1.5,
      bias: 3,
      clamp,
      preserveAlpha: false,
    };
    const rect = { x: -3, y: -5, width: sw + 4, height: sh + 9 };
    const expected = new BitmapStore(sw + 4, sh + 9, true, 0);
    applyFilter(expected, source, rect, 0, 0, f);
    for (const owner of owners) {
      const dest = new BitmapStore(sw + 4, sh + 9, true, 0);
      let calls = 0;
      applyFilter(dest, source, rect, 0, 0, f, null, (...args) => {
        calls++;
        const out = owner.convolve(...args);
        assert.ok(out, "unexpected rejection");
        return out;
      });
      assert.equal(calls, 1);
      assert.deepEqual(dest.pixels, expected.pixels, `clamp ${clamp}`);
    }
  }

  for (const owner of owners) {
    owner.dispose();
  }
});

test("published convolution pixels survive growth, rejection, scratch reuse and disposal", () => {
  const native = new Convolver();
  const source = new BitmapStore(16, 16, true, 0x80305070);
  const out = native.convolve(source, area, filter(), true);
  assert.ok(out);
  const previous = out.slice();
  const capacity = native.capacity;
  assert.equal(native.convolve(source, { ...area, width: 0x100001 }, filter(), true), null);
  assert.equal(native.capacity, capacity, "preflight rejection must retain valid scratch");
  const large = new BitmapStore(2048, 2048, true, 0xff884422);
  assert.ok(native.convolve(large, { ...area, width: 2048, height: 2048 }, filter(), true));
  assert.ok(native.capacity > 0 && native.capacity <= 4 << 20, "large rects run in small bands");
  const small = new Convolver({ retainMemory: 1 << 16 });
  assert.ok(small.convolve(large, { ...area, width: 64, height: 64 }, filter(), true));
  assert.equal(small.capacity, 0, "scratch over retainMemory must be discarded");
  assert.ok(native.convolve(source, area, filter(), true));
  native.dispose();
  assert.equal(native.capacity, 0);
  assert.deepEqual(out, previous);
});

test("native rejection and traps preserve JS fallback and distinguish scratch recovery", () => {
  const Instance = wasm.Instance;
  let instances = 0;
  let fail: "reject" | "trap" | null = "reject";
  wasm.Instance = new Proxy(Instance, {
    construct(target, args) {
      const instance = Reflect.construct(target, args) as WebAssembly.Instance;
      instances++;
      return {
        exports: {
          ...instance.exports,
          convolve: (...values: number[]) => {
            if (fail === "trap") {
              throw new wasm.RuntimeError("test trap");
            }
            if (fail === "reject") {
              return 0;
            }
            return (instance.exports.convolve as (...args: number[]) => number)(...values);
          },
        },
      };
    },
  });
  try {
    const native = new Convolver();
    const source = new BitmapStore(16, 16, true, 0x80305070);
    const expected = new BitmapStore(16, 16, true, 0);
    applyFilter(expected, source, area, 0, 0, filter());
    for (const state of ["reject", "trap", null] as const) {
      fail = state;
      const dest = new BitmapStore(16, 16, true, 0);
      applyFilter(dest, source, area, 0, 0, filter(), null, native.convolve);
      assert.deepEqual(dest.pixels, expected.pixels);
      assert.equal(native.capacity === 0, state === "trap");
    }

    assert.equal(instances, 2, "rejection reuses scratch, a trap requires a fresh instance");
    native.dispose();
  } finally {
    wasm.Instance = Instance;
  }
});

test("invalid custom output or a throwing custom kernel falls back before writing", () => {
  const source = new BitmapStore(16, 16, true, 0x80305070);
  const expected = new BitmapStore(16, 16, true, 0);
  applyFilter(expected, source, area, 0, 0, filter());
  for (const hook of [
    () => null,
    () => new Uint32Array(1),
    () => {
      throw Error("test");
    },
  ]) {
    const dest = new BitmapStore(16, 16, true, 0);
    applyFilter(dest, source, area, 0, 0, filter(), null, hook);
    assert.deepEqual(dest.pixels, expected.pixels);
    assert.equal(dest.version, expected.version);
  }
});

test("the native bitmap module imports nothing and exposes only the kernel ABI", async () => {
  const module = await WebAssembly.compile(Buffer.from(binary, "base64"));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.deepEqual(
    WebAssembly.Module.exports(module)
      .map((e) => e.name)
      .sort(),
    ["capacity", "convolve", "memory", "resetArena"],
  );
});

test("a compilation refusal, as without wasm SIMD, leaves JS and is tried once per owner", async () => {
  const fresh = async (name: string) =>
    (await import(
      new URL(`../../packages/native/dist/bitmap/index.js?${name}`, import.meta.url).href
    )) as typeof import("@swf2es/native/bitmap");
  const Module = wasm.Module;
  let attempts = 0;
  wasm.Module = new Proxy(Module, {
    construct() {
      attempts++;
      throw Error("test compilation refusal");
    },
  });
  try {
    const source = new BitmapStore(16, 16, true, 0x80305070);
    const expected = new BitmapStore(16, 16, true, 0);
    applyFilter(expected, source, area, 0, 0, filter());
    const { Convolver: Blocked } = await fresh("blocked");
    const unavailable = new Blocked();
    const dest = new BitmapStore(16, 16, true, 0);
    applyFilter(dest, source, area, 0, 0, filter(), null, unavailable.convolve);
    assert.deepEqual(dest.pixels, expected.pixels);
    assert.equal(attempts, 1);
    assert.equal(unavailable.convolve(source, area, filter(), true), null);
    assert.equal(attempts, 1, "a refused module is not compiled again for the same owner");
    assert.equal(unavailable.capacity, 0);
  } finally {
    wasm.Module = Module;
  }
});
