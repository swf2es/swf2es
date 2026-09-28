// Loads the test build of codegen (packages/codegen/assembly/testing.ts).
//
// Its runtime collects garbage only when asked, between calls: every
// COLLECT_EVERY calls, and after a call that grew memory. Memory never
// shrinks, so collecting only on growth would let each cycle's garbage grow
// it a little further.
import { readFile } from "node:fs/promises";

// SWF2ES_CHECKED selects the build that checks every array access (pnpm test:checked).
const build = process.env.SWF2ES_CHECKED ? "dist-test-checked" : "dist-test";
const dir = new URL(`../../../packages/codegen/${build}/`, import.meta.url);
const { instantiate } = await import(new URL("testing.js", dir).href);
const module = await WebAssembly.compile(await readFile(new URL("testing.wasm", dir)));
const COLLECT_EVERY = 64;

// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
const exports: any = await instantiate(module, { env: {} });
let size = exports.memory.buffer.byteLength;
let calls = 0;

// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
export const testing: any = new Proxy(exports, {
  get(target, name) {
    const value = target[name];
    if (typeof value !== "function" || String(name).startsWith("__")) {
      return value;
    }

    return (...args: unknown[]) => {
      const result = value.apply(target, args);
      const grown = target.memory.buffer.byteLength;
      if (grown > size || ++calls >= COLLECT_EVERY) {
        target.__collect();
        size = grown;
        calls = 0;
      }

      return result;
    };
  },
});
