/**
 * Compiles ABC (and later AVM1) bytecode to ES modules.
 *
 * The compiler itself is AssemblyScript (assembly/), built to codegen.wasm.
 * This wrapper instantiates it and gives its exports their types. The same wasm runs as the browser JIT
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

/** What an ABC compiles to: its module, the module's source map, and each compiled method body's entry in it. */
export interface Compiled {
  module: string;
  /** JSON: the module's lines mapped to the AS3 lines debugline names. */
  sourceMap: string;
  /** By method body index: the body's entry in the module's F, as the JIT compiles it alone. */
  entries: Map<number, string>;
}

/**
 * The compiler. ABCs are added to a domain in the order the SWF loads them
 * (the builtins first), and the last one added compiles, whole or a method
 * at a time, to code that is byte for byte the same either way.
 */
export interface Codegen {
  /** The version at the start of an ABC block, or null if it is too short. */
  abcVersion(abc: Uint8Array): AbcVersion | null;
  /** Start a domain whose user ABCs have API version `apiVersion`: Flash Player's, 50, by default. */
  reset(apiVersion?: number): void;
  /** Add an ABC, linking it against those before it; 0, or the VerifyError it was rejected with. */
  add(abc: Uint8Array, builtin?: boolean): number;
  /** The last ABC added compiled whole; `hashes` are the ABCs' hashes in load order, as the cache key names them. */
  compile(hashes?: string[]): Compiled;
  /** Method bodies of the last ABC compiled alone, as the JIT compiles each on its first call; a native or unverified one is left out. */
  compileMethods(bodies: number[]): Map<number, string>;
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
    reset(apiVersion = 50) {
      collected(wasm.domainReset(apiVersion));
    },
    add(abc, builtin = false) {
      return collected(wasm.domainAdd(abc, builtin));
    },
    compile(hashes = []) {
      const module = wasm.domainModule(hashes.join("\n"));
      const sourceMap = wasm.domainSourceMap();
      const entries = parseEntries(wasm.domainModuleEntries());
      collected(undefined);
      return { module, sourceMap, entries };
    },
    compileMethods(bodies) {
      return parseEntries(collected(wasm.domainEmitEach(bodies.join(","), true)));
    },
  };
}

/** Entries as the wasm writes them: for each, the body's index, U+0001, its entry, U+0002. */
function parseEntries(text: string): Map<number, string> {
  const entries = new Map<number, string>();
  for (const item of text.split("\u0002")) {
    const at = item.indexOf("\u0001");
    if (at > 0) {
      entries.set(Number(item.slice(0, at)), item.slice(at + 1));
    }
  }

  return entries;
}

const COLLECT_EVERY = 64;
