// Loads the compiler's test builds (packages/codegen/zig/src/testing.zig):
// the compiler's exports and the tests' own, bound as
// packages/codegen/src/zig.ts binds the compiler's.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { bind, SIGNATURES, type Signature } from "../../../packages/codegen/dist/zig.js";

/**
 * The test build, or the one that fills every freed run and rolled-back
 * allocation with 0xAA, which must give the same output.
 */
export type Build = "testing" | "testing-poison";

/** The build the tests run on: the 0xAA build under SWF2ES_CHECKED (pnpm test:checked). */
export const TESTED: Build = process.env.SWF2ES_CHECKED ? "testing-poison" : "testing";

const TESTING_SIGNATURES: Record<string, Signature> = {
  memoryChunksUsed: ["", "i32"],
  // Read as unsigned, as an address is: memory past 2 GiB.
  memoryReached: ["", "address"],
  memoryTopRuns: ["", "i32"],
  memoryReserve: ["i32", "void"],
  domainMemoryReport: ["", "str"],
  domainPinPolicy: ["i32", "void"],
  domainRebuildPhases: ["bool", "void"],
  domainRebuildStepWork: ["", "str"],
  domainOutsideFindings: ["bool=false", "i32"],
  domainGapProbe: ["i32", "void"],
  testingPanic: ["", "void"],
  testingOverflow: ["i32", "i32"],
  stackPaint: ["", "void"],
  stackDeepest: ["", "i32"],
  avm1Opcodes: ["", "str"],
  avm1Dump: ["u8s", "str"],
  avm1Check: ["u8s", "str"],
  avm1Action: ["u8s i32", "str"],
  readAll: ["u8s u8s", "f64s"],
  poolDump: ["u8s", "str"],
  abcDump: ["u8s bool=false", "str"],
  opcodeTable: ["", "str"],
  domainFind: ["i32 str str i32 i32=0", "str"],
  domainSummary: ["", "str"],
  domainTraits: ["i32", "str"],
  domainResolve: ["i32", "i32"],
  domainBuiltins: ["", "str"],
  domainSlotTypes: ["i32 i32", "str"],
  domainTraitsCount: ["", "i32"],
  unspecifiedReads: ["", "i32"],
  benchParse: ["u8s i32", "i32"],
  benchDecode: ["u8s i32", "i32"],
  codeDump: ["u8s bool=false", "str"],
  domainVerifyAll: ["", "str"],
  domainIr: ["i32", "str"],
  domainCheckIr: ["", "str"],
  domainIrAll: ["", "str"],
  domainEmit: ["i32", "str"],
  domainEmitEach: ["str bool i32=-1", "str"],
  domainEmitEachBytes: ["str bool i32=-1", "address"],
  domainPartBudget: ["i32", "void"],
  domainRebuild: ["bool=false", "bool"],
};

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
