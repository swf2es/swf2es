// Loads the test build of codegen (packages/codegen/assembly/testing.ts).
//
// Its runtime collects garbage only when asked, between calls: after a call
// that grew memory by COLLECT_AFTER bytes since the last collection.
import { readFile } from "node:fs/promises";

const dir = new URL("../../../packages/codegen/dist-test/", import.meta.url);
const { instantiate } = await import(new URL("testing.js", dir).href);
const module = await WebAssembly.compile(await readFile(new URL("testing.wasm", dir)));
const COLLECT_AFTER = 64 << 20;

// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
const exports: any = await instantiate(module, { env: {} });
let collectedAt = exports.memory.buffer.byteLength;

// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
export const testing: any = new Proxy(exports, {
  get(target, name) {
    const value = target[name];
    if (typeof value !== "function" || String(name).startsWith("__")) {
      return value;
    }

    return (...args: unknown[]) => {
      const result = value.apply(target, args);
      const size = target.memory.buffer.byteLength;
      if (size > collectedAt + COLLECT_AFTER) {
        target.__collect();
        collectedAt = size;
      }

      return result;
    };
  },
});
