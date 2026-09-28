/**
 * Compiles ABC (and later AVM1) bytecode to ES modules.
 *
 * The compiler itself is AssemblyScript (assembly/), built to codegen.wasm.
 * This wrapper only instantiates it. The same wasm runs as the browser JIT
 * (lazily, per method, in a worker pool) and as the ahead-of-time compiler,
 * so both produce identical output. See docs/architecture.md.
 */
import { instantiate } from "./codegen.js";

/** Bumped whenever generated code or the runtime ABI it calls changes. */
export const COMPILER_VERSION = "0.0.0";

/**
 * Cache key for compiled output. Browser caches, the AOT server and the JIT
 * all use this key, so their results are interchangeable. `linked` are the
 * hashes of the ABCs loaded before this one, in order, whose layouts the
 * output depends on.
 */
export function cacheKey(abcHash: string, linked: string[] = []): string {
  return `swf2es@${COMPILER_VERSION}:${[...linked, abcHash].join("+")}`;
}

export interface AbcVersion {
  major: number;
  minor: number;
}

export interface Codegen {
  /** The version at the start of an ABC block, or null if it is too short. */
  abcVersion(abc: Uint8Array): AbcVersion | null;
}

/**
 * Instantiate the compiler from a compiled codegen.wasm module. Loading the
 * bytes is left to the caller (fetch in browsers, fs in node), which keeps
 * this package free of I/O. The file ships as `@swf2es/codegen/codegen.wasm`.
 */
export async function createCodegen(module: WebAssembly.Module): Promise<Codegen> {
  const wasm = await instantiate(module, { env: {} });
  const version = wasm.compilerVersion();
  if (version !== COMPILER_VERSION) {
    throw new Error(
      `codegen.wasm is version ${version} but the wrapper expects ${COMPILER_VERSION}`,
    );
  }

  // codegen.wasm uses AssemblyScript's minimal runtime, which collects
  // garbage only when asked. Nothing runs in wasm between calls, so that is
  // when: every COLLECT_EVERY calls, and after a call that grew memory.
  // Memory never shrinks, so collecting only on growth would let each
  // cycle's garbage grow it a little further.
  let size = wasm.memory.buffer.byteLength;
  let calls = 0;
  const collected = <T>(result: T): T => {
    const grown = wasm.memory.buffer.byteLength;
    if (grown > size || ++calls >= COLLECT_EVERY) {
      wasm.__collect();
      size = grown;
      calls = 0;
    }

    return result;
  };

  return {
    abcVersion(abc) {
      const packed = collected(wasm.abcVersion(abc));
      return packed < 0 ? null : { major: packed >>> 16, minor: packed & 0xffff };
    },
  };
}

const COLLECT_EVERY = 64;
