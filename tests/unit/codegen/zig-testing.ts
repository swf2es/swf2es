// The test builds of the compiler in Zig (packages/codegen/zig/src/testing.zig,
// docs/zig-codegen.md): their exports beyond the compiler's, bound as
// packages/codegen/src/zig.ts binds those, so that they stand in for
// assembly/testing.ts's build behind the same calls. Each stage of the
// port adds the dumps it ports.
import { readFile } from "node:fs/promises";
import { bind, SIGNATURES, type Signature } from "../../../packages/codegen/dist/zig.js";

const TESTING_SIGNATURES: Record<string, Signature> = {
  memoryChunksUsed: ["", "i32"],
  memoryReached: ["", "i32"],
  testingPanic: ["", "void"],
  testingOverflow: ["i32", "i32"],
  stackPaint: ["", "void"],
  stackDeepest: ["", "i32"],
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
export function bindTesting(module: WebAssembly.Module): Promise<any> {
  return bind(module, { ...SIGNATURES, ...TESTING_SIGNATURES }, [
    "memoryChunksUsed",
    "memoryReached",
    "stackDeepest",
  ]);
}
