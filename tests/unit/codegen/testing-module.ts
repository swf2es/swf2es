// Loads the test build of codegen (packages/codegen/assembly/testing.ts).
//
// Its runtime collects garbage only when asked, between calls: every
// COLLECT_EVERY calls, and after a call that grew memory. Memory never
// shrinks, so collecting only on growth would let each cycle's garbage grow
// it a little further.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** The release build, or the one that checks every array access (pnpm test:checked). */
export type Build = "dist-test" | "dist-test-checked";

const COLLECT_EVERY = 64;

/** The exports that hand UTF-8 out where it is in memory, by address, outputLength bytes of it. */
const HANDED_OUT = new Set([
  "domainModuleBytes",
  "domainLazyModuleBytes",
  "domainEmitEachBytes",
  "actionsModuleBytes",
  "actionsEmitEachBytes",
  "actionsUnitBytes",
]);

/** A new instance of `build`, with a memory of its own. */
// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
export async function loadTesting(build: Build): Promise<any> {
  return (await testingInstances(build))();
}

/** New instances of `build`, each with a memory of its own, its module compiled once. */
// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
export async function testingInstances(build: Build): Promise<() => Promise<any>> {
  // SWF2ES_CODEGEN=<dir> loads another copy of the release build, to compare two (tests/programs/ab.ts).
  const other = build === "dist-test" ? process.env.SWF2ES_CODEGEN : undefined;
  const dir = other
    ? pathToFileURL(`${other.replace(/\/$/, "")}/`)
    : new URL(`../../../packages/codegen/${build}/`, import.meta.url);
  const { instantiate } = await import(new URL("testing.js", dir).href);
  const module = await WebAssembly.compile(await readFile(new URL("testing.wasm", dir)));
  return () => instance(instantiate, module);
}

async function instance(
  instantiate: (module: WebAssembly.Module, imports: object) => Promise<unknown>,
  module: WebAssembly.Module,
  // biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
): Promise<any> {
  // biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
  const exports: any = await instantiate(module, { env: {} });
  let size = exports.memory.buffer.byteLength;
  let calls = 0;
  return new Proxy(exports, {
    get(target, name) {
      const value = target[name];
      if (typeof value !== "function" || String(name).startsWith("__")) {
        return value;
      }

      return (...args: unknown[]) => {
        let result = value.apply(target, args);
        // Copied out before a collection may free them, or another call move
        // them; an older build (SWF2ES_CODEGEN) gave a copy already.
        if (HANDED_OUT.has(String(name)) && typeof result === "number") {
          result = new Uint8Array(target.memory.buffer, result, target.outputLength()).slice();
        }

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
}

// SWF2ES_CHECKED selects the checked build.
// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
export const testing: any = await loadTesting(
  process.env.SWF2ES_CHECKED ? "dist-test-checked" : "dist-test",
);
