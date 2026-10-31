// Whole-level DXT encoding, including copying input into wasm, against
// the TypeScript reference. Run after pnpm build; --crossings counts actual
// exports separately from timing, and --json emits one result per workload.
import assert from "node:assert/strict";
import { encodeDxt } from "../../packages/context3d/dist/dxt.js";
import { DxtEncoder } from "../../packages/native/dist/render/index.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const crossings = args.includes("--crossings");
const sizes = args.includes("--large") ? [2048] : [4, 16, 64, 256, 1024, 2048];
const calls: Record<string, number> = {};
if (crossings) {
  const wasm = globalThis.WebAssembly as unknown as {
    Instance: new (module: WebAssembly.Module, imports?: object) => WebAssembly.Instance;
  };
  wasm.Instance = new Proxy(wasm.Instance, {
    construct(target, args) {
      const instance = Reflect.construct(target, args) as WebAssembly.Instance;
      const exports = Object.fromEntries(
        Object.entries(instance.exports).map(([name, value]) => [
          name,
          typeof value === "function"
            ? (...args: number[]) => {
                calls[name] = (calls[name] ?? 0) + 1;
                return value(...args);
              }
            : value,
        ]),
      );

      return new Proxy(instance, {
        get(target, name) {
          return name === "exports" ? exports : Reflect.get(target, name, target);
        },
      });
    },
  });
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
const encoder = new DxtEncoder();
for (const size of sizes) {
  for (const pattern of ["flat", "gradient", "noise"]) {
    const rgba = new Uint8Array(size * size * 4);
    let seed = 71;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        for (let c = 0; c < 4; c++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          switch (pattern) {
            case "flat":
              rgba[i + c] = [33, 99, 173, 201][c];
              break;
            case "gradient":
              rgba[i + c] = Math.round(((x + y) * (c + 1) * 255) / (6 * size));
              break;
            default:
              rgba[i + c] = seed >>> 24;
          }
        }
      }
    }

    for (const dxt5 of [false, true]) {
      const expected = encodeDxt(rgba, dxt5, size, size);
      const native = encoder.encode(rgba, dxt5, size, size);
      assert.ok(native, "the benchmark must use the native encoder");
      assert.deepEqual(native, expected);
      if (crossings) {
        for (const key of Object.keys(calls)) {
          calls[key] = 0;
        }

        const before: number = encoder.encoded;
        assert.ok(encoder.encode(rgba, dxt5, size, size));
        assert.equal(encoder.encoded, before + 1);
        assert.equal(calls.encodeDxt, 1);
        assert.equal(calls.resetArena, 0);
        console.log(JSON.stringify({ size, pattern, dxt5, calls: { ...calls } }));
        continue;
      }

      const iterations = Math.min(2048, Math.max(1, Math.floor(1e6 / (size * size))));
      const run = (native: boolean) => {
        const before: number = encoder.encoded;
        const start = performance.now();
        for (let i = 0; i < iterations; i++) {
          if (native) {
            encoder.encode(rgba, dxt5, size, size);
          } else {
            encodeDxt(rgba, dxt5, size, size);
          }
        }

        const elapsed = (performance.now() - start) / iterations;
        if (native) {
          assert.equal(encoder.encoded - before, iterations);
        }

        return elapsed;
      };
      for (let i = 0; i < 3; i++) {
        run(false);
        run(true);
      }

      const times: [number[], number[]] = [[], []];
      for (let round = 0; round < 7; round++) {
        for (const index of round % 2 ? [1, 0] : [0, 1]) {
          times[index].push(run(index === 1));
        }
      }

      const tsMs = median(times[0]);
      const nativeMs = median(times[1]);
      const result = {
        size,
        pattern,
        dxt5,
        iterations,
        tsMs,
        nativeMs,
        speedup: tsMs / nativeMs,
        times,
      };
      console.log(
        json
          ? JSON.stringify(result)
          : `${size}² ${dxt5 ? "DXT5" : "DXT1"} ${pattern}: TS ${tsMs.toFixed(4)} ms, native ${nativeMs.toFixed(4)} ms (${result.speedup.toFixed(2)}×)`,
      );
    }
  }
}

encoder.release();
