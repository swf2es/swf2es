// The compiler the tests run on, by SWF2ES_COMPILER: `as`, AssemblyScript's
// codegen.wasm, by default, or `zig`, the compiler in Zig while it is
// ported (docs/zig-codegen.md), as far as it is. Any other value is refused.
// (SWF2ES_CODEGEN is another thing: a directory holding another copy of the
// release build, for the A/B benchmarks.)
//
// Imported, under `zig` it makes `@swf2es/codegen/codegen.wasm` resolve to
// codegen-zig.wasm for every loader in the process: tests/unit's runner
// imports it first (checked.ts), and runners of their own import it.
import { registerHooks } from "node:module";

export type Compiler = "as" | "zig";

function chosen(): Compiler {
  const value = process.env.SWF2ES_COMPILER ?? "as";
  if (value !== "as" && value !== "zig") {
    throw new Error(`SWF2ES_COMPILER is ${value}: as or zig`);
  }

  return value;
}

export const COMPILER: Compiler = chosen();

/** The release build's file in @swf2es/codegen's dist/. */
export const CODEGEN_WASM = COMPILER === "zig" ? "codegen-zig.wasm" : "codegen.wasm";

if (COMPILER === "zig") {
  registerHooks({
    resolve(specifier, context, next) {
      return next(
        specifier === "@swf2es/codegen/codegen.wasm"
          ? "@swf2es/codegen/codegen-zig.wasm"
          : specifier,
        context,
      );
    },
  });
}
