import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapKernel } from "@swf2es/native/render";
import { binary } from "../../packages/native/dist/render/binary.js";
import { BitmapStore } from "../../packages/player/dist/bitmap/bitmap.js";
import { applyFilter } from "../../packages/player/dist/bitmap/filters.js";
import { filterDefaults } from "../../packages/player/dist/display/filters.js";
import { convolveReference } from "./player/bitmap/convolution-reference.ts";

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

test("the kernel convolves as the JS reference does, to the bit, whatever the filter", () => {
  let seed = 89371;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)];
  const special = [NaN, Infinity, -Infinity, -0, 0, 1e-300, 1e300, -1e300, 1 / 3, -1 / 3];
  const number = (n: number) => (random() < 0.1 ? pick(special) : (random() * 2 - 1) * n);
  const owners = [new BitmapKernel()];
  let calls = 0;
  for (let i = 0; i < 5000; i++) {
    const sw = 1 + ((random() * 17) | 0),
      sh = 1 + ((random() * 13) | 0);
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
    const transparent = random() < 0.5,
      destTransparent = random() < 0.5;
    const far = i % 53 === 0 ? pick([-1e9, 1e9]) : 0;
    const rect = {
      x: far + ((random() * (sw + 8)) | 0) - 4,
      y: ((random() * (sh + 8)) | 0) - 4,
      width: ((random() * (sw + 6)) | 0) - 1,
      height: ((random() * (sh + 6)) | 0) - 1,
    };
    // A kernel of no taps never reaches the kernel: applyFilter copies the source (copyEmpty).
    if (cols === 0 || rows === 0) {
      continue;
    }

    const source = new BitmapStore(sw, sh, transparent, 0);
    source.pixels.set(pixels);
    // A rect the kernel is asked for, as applyFilter clips it: within reach of the bitmap.
    const shown = {
      x: rect.x,
      y: rect.y,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    };
    const expected = convolveReference(source, shown, f, destTransparent);
    for (const owner of owners) {
      calls++;
      const out = owner.convolve(source, shown, f, destTransparent);
      assert.ok(out, `unexpected rejection in case ${i}`);
      assert.deepEqual(out, expected, `case ${i}, seed 89371`);
    }
  }

  assert.ok(calls > 3000, "differential cases must actually invoke the native kernels");
  for (const owner of owners) {
    owner.dispose();
    assert.equal(owner.capacity, 0);
  }
});

test("a rect convolved in bands of rows matches the reference across the bands' seams", () => {
  // Wide enough that the rect takes several bands; the rows a band's kernel
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

  const native = new BitmapKernel();
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
    assert.deepEqual(
      native.convolve(source, rect, f, true),
      convolveReference(source, rect, f, true),
      `clamp ${clamp}`,
    );
  }

  native.dispose();
});

test("published convolution pixels survive growth, rejection, scratch reuse and disposal", () => {
  const native = new BitmapKernel();
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
  const small = new BitmapKernel({ retainMemory: 1 << 16 });
  assert.ok(small.convolve(large, { ...area, width: 64, height: 64 }, filter(), true));
  assert.equal(small.capacity, 0, "scratch over retainMemory must be discarded");
  assert.ok(native.convolve(source, area, filter(), true));
  native.dispose();
  assert.equal(native.capacity, 0);
  assert.deepEqual(out, previous);
});

test("applyFilter convolves again in a new instance after a trap, and writes nothing if it traps again", async () => {
  const Instance = wasm.Instance;
  let instances = 0;
  let traps = 0;
  wasm.Instance = new Proxy(Instance, {
    construct(target, args) {
      const instance = Reflect.construct(target, args) as WebAssembly.Instance;
      instances++;
      return {
        exports: {
          ...instance.exports,
          convolve: (...values: number[]) => {
            if (traps > 0) {
              traps--;
              throw new wasm.RuntimeError("test trap");
            }
            return (instance.exports.convolve as (...args: number[]) => number)(...values);
          },
        },
      };
    },
  });
  try {
    // A module of its own, whose realm kernel is made here, under the proxy, whatever ran before.
    const copy = `${new URL("../../packages/player/dist/bitmap/filters.js", import.meta.url)}?trap`;
    const { applyFilter: fresh } = (await import(copy)) as { applyFilter: typeof applyFilter };
    const source = new BitmapStore(16, 16, true, 0x80305070);
    const expected = convolveReference(source, area, filter(), true);
    traps = 1;
    const dest = new BitmapStore(16, 16, true, 0);
    fresh(dest, source, area, 0, 0, filter());
    assert.deepEqual(dest.pixels, expected);
    assert.equal(instances, 2, "the trapped call made again in a new instance");

    traps = 2;
    const untouched = new BitmapStore(16, 16, true, 0x11223344);
    const before = untouched.pixels.slice();
    fresh(untouched, source, area, 0, 0, filter());
    assert.deepEqual(untouched.pixels, before);
  } finally {
    wasm.Instance = Instance;
  }
});

test("a trapped kernel instance is replaced, a rejected call keeps it", () => {
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
    const native = new BitmapKernel();
    const source = new BitmapStore(16, 16, true, 0x80305070);
    for (const state of ["reject", "trap", null] as const) {
      fail = state;
      const out = native.convolve(source, area, filter(), true);
      assert.equal(out === null, state !== null);
      assert.equal(native.capacity === 0, state === "trap");
    }

    // The trap made again in a new instance, which traps too; then a third, which convolves.
    assert.equal(instances, 3, "rejection reuses scratch, a trap requires a fresh instance");
    native.dispose();
  } finally {
    wasm.Instance = Instance;
  }
});

test("a rect far past the bitmap convolves as the reference does there, beyond the kernel's bounds", () => {
  const source = new BitmapStore(4, 4, true, 0);
  for (let i = 0; i < 16; i++) {
    source.pixels[i] = (0xff000000 | (i * 0x0f0b07)) >>> 0;
  }

  for (const clamp of [true, false]) {
    const f = { ...filter(), clamp };
    for (const x of [-0x3fffffff - 5, 0x3fffffff + 5]) {
      const rect = { x, y: 0, width: 4, height: 4 };
      const dest = new BitmapStore(4, 4, true, 0x12345678);
      applyFilter(dest, source, rect, 0, 0, f);
      assert.deepEqual(
        dest.pixels,
        convolveReference(source, rect, f, true),
        `${x}, clamp ${clamp}`,
      );
    }
  }
});

test("the render module exposes the bitmap kernel's ABI", async () => {
  const module = await WebAssembly.compile(Buffer.from(binary, "base64"));
  const names = WebAssembly.Module.exports(module).map((e) => e.name);
  for (const name of ["capacity", "convolve", "memory", "resetArena"]) {
    assert.ok(names.includes(name), name);
  }
});

test("an instance that cannot be made gives no pixels, and is tried again on the next call", () => {
  const Instance = wasm.Instance;
  let attempts = 0;
  wasm.Instance = new Proxy(Instance, {
    construct() {
      attempts++;
      throw Error("test instantiation refusal");
    },
  });
  try {
    const source = new BitmapStore(16, 16, true, 0x80305070);
    const unavailable = new BitmapKernel();
    assert.equal(unavailable.convolve(source, area, filter(), true), null);
    assert.equal(unavailable.convolve(source, area, filter(), true), null);
    assert.equal(attempts, 2);
    assert.equal(unavailable.capacity, 0);
  } finally {
    wasm.Instance = Instance;
  }
});
