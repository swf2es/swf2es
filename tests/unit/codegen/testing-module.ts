// Loads the test build of codegen (packages/codegen/assembly/testing.ts).
//
// Its runtime collects garbage only when asked, between calls: every
// COLLECT_EVERY calls, and after a call that grew memory. Memory never
// shrinks, so collecting only on growth would let each cycle's garbage grow
// it a little further.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { COMPILER } from "../../compiler.ts";
import { bindTesting, zigTestingModule } from "./zig-testing.ts";

/** The release build, or the one that checks every array access (pnpm test:checked). */
export type Build = "dist-test" | "dist-test-checked";

const COLLECT_EVERY = 64;

/** The exports that hand UTF-8 out where it is in memory, by address, outputLength bytes of it. */
const HANDED_OUT = new Set([
  "domainModuleBytes",
  "domainModuleMoreBytes",
  "domainEmitEachBytes",
  "domainKeyHeaderBytes",
  "domainKeyLogBytes",
  "actionsModuleBytes",
  "actionsEmitEachBytes",
  "actionsUnitBytes",
]);

/**
 * `build` compiled. SWF2ES_CODEGEN=<dir> gives another copy of the test
 * build in its place, to compare two (tests/programs/ab.ts).
 */
export async function testingModule(build: Build): Promise<WebAssembly.Module> {
  const other = build === "testing" ? process.env.SWF2ES_CODEGEN : undefined;
  const dir = other
    ? pathToFileURL(`${other.replace(/\/$/, "")}/`)
    : new URL("../../../packages/codegen/dist-test/", import.meta.url);
  return WebAssembly.compile(await readFile(new URL(`${build}.wasm`, dir)));
}

/** An instance of a test build, with a memory of its own, its exports as they come. */
// biome-ignore lint/suspicious/noExplicitAny: the tests' exports are many, and typed by their signatures alone
export async function bindTesting(module: WebAssembly.Module): Promise<any> {
  // biome-ignore lint/suspicious/noExplicitAny: as above
  const bound: any = await bind(module, { ...SIGNATURES, ...TESTING_SIGNATURES }, [
    "memoryChunksUsed",
    "memoryReached",
    "memoryTopRuns",
    "stackDeepest",
  ]);
  // The ABC reader's kinds, by which readAll is told what to read.
  for (const [i, name] of ["U8", "U16", "S24", "U30", "U32", "S32", "D64", "UTF8"].entries()) {
    bound[name] = { value: i };
  }

  return bound;
}

/** A new instance of `build`, with a memory of its own. */
// biome-ignore lint/suspicious/noExplicitAny: as bindTesting
export async function loadTesting(build: Build): Promise<any> {
  return (await testingInstances(build))();
}

/**
 * New instances of `build`, each with a memory of its own, its module
 * compiled once, and what an export hands out copied, before the next call
 * gives its memory back.
 */
// biome-ignore lint/suspicious/noExplicitAny: as bindTesting
export async function testingInstances(build: Build): Promise<() => Promise<any>> {
  const module = await testingModule(build);
  return async () => {
    const exports = await bindTesting(module);
    return new Proxy(exports, {
      get(target, name) {
        const value = target[name];
        if (typeof value !== "function" || !HANDED_OUT.has(String(name))) {
          return value;
        }

        return (...args: unknown[]) => {
          const address = value.apply(target, args);
          return new Uint8Array(target.memory.buffer, address, target.outputLength()).slice();
        };
      },
    });
  };
}

// biome-ignore lint/suspicious/noExplicitAny: as bindTesting
export const testing: any = await loadTesting(TESTED);
