// swf2es codegen, compiled to WebAssembly with AssemblyScript.
//
// Compilation must be a pure function of its input (see docs/architecture.md):
// no imports besides abort, no clock, no randomness. Running as wasm makes the
// output identical in the browser JIT, in node and in any server-side runtime.

/** Must equal COMPILER_VERSION in src/index.ts; the wrapper checks it on load. */
export function compilerVersion(): string {
  return "0.0.0";
}

/**
 * The version at the start of an ABC block, packed as (major << 16) | minor,
 * or -1 when the block is shorter than the 4-byte header.
 */
export function abcVersion(abc: Uint8Array): i32 {
  if (abc.length < 4) {
    return -1;
  }
  const minor = <i32>abc[0] | ((<i32>abc[1]) << 8);
  const major = <i32>abc[2] | ((<i32>abc[3]) << 8);
  return (major << 16) | minor;
}

// The compiler: see compile.ts.
export {
  domainAdd,
  domainChild,
  domainCompact,
  domainDrop,
  domainEmitEach,
  domainFound,
  domainModule,
  domainModuleEntries,
  domainReset,
  domainSourceMap,
} from "./compile";
