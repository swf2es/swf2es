// The test builds of the compiler in Zig (packages/codegen/zig/src/testing.zig,
// docs/zig-codegen.md): their exports beyond the compiler's, bound as
// packages/codegen/src/zig.ts binds those, so that they stand in for
// assembly/testing.ts's build behind the same calls. Each stage of the
// port adds the dumps it ports.
import { readFile } from "node:fs/promises";
import { bind, SIGNATURES, type Signature } from "../../../packages/codegen/dist/zig.js";

const TESTING_SIGNATURES: Record<string, Signature> = {
  memoryChunksUsed: ["", "i32"],
  // Read as unsigned, as an address is: memory past 2 GiB.
  memoryReached: ["", "address"],
  memoryTopRuns: ["", "i32"],
  memoryReserve: ["i32", "void"],
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

/** The test build, or the one that fills freed memory with 0xAA, compiled. */
export async function zigTestingModule(poison: boolean): Promise<WebAssembly.Module> {
  const file = poison ? "testing-zig-poison.wasm" : "testing-zig.wasm";
  return WebAssembly.compile(
    await readFile(new URL(`../../../packages/codegen/dist-test/${file}`, import.meta.url)),
  );
}

/** An instance of a Zig test build, with a memory of its own. */
// biome-ignore lint/suspicious/noExplicitAny: as untyped as asc's bindings for the AssemblyScript build
export async function bindTesting(module: WebAssembly.Module): Promise<any> {
  // biome-ignore lint/suspicious/noExplicitAny: as untyped as asc's bindings for the AssemblyScript build
  const bound: any = await bind(module, { ...SIGNATURES, ...TESTING_SIGNATURES }, [
    "memoryChunksUsed",
    "memoryReached",
    "memoryTopRuns",
    "stackDeepest",
  ]);
  // testing/abc.ts's reader kinds, which asc exports as globals.
  for (const [i, name] of ["U8", "U16", "S24", "U30", "U32", "S32", "D64", "UTF8"].entries()) {
    bound[name] = { value: i };
  }

  return bound;
}
