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

/**
 * A definition an application domain has found by name, or as a type,
 * which is not the first one from the root down, as the runtime reports it:
 * what the domain's later ABCs compile against (see Codegen.found).
 */
export interface FoundDefinition {
  /** The application domain that found it. */
  domain: number;
  /** The name's namespace: its kind (0 public, 1 package-internal, ...) and URI. */
  nsKind: number;
  uri: string;
  name: string;
  /** The ABC that defines it, by its position among those added. */
  abc: number;
  /** Found as a type (avmplus' cached traits), else by name (cached scripts). */
  asType: boolean;
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
  /**
   * Add an ABC, loaded into application domain `appDomain` (0, the root, by
   * default), linking it against what that domain sees of those before it;
   * 0, or the VerifyError it was rejected with (then it is not added).
   */
  add(abc: Uint8Array, builtin?: boolean, appDomain?: number): number;
  /** A new application domain, a child of `parent`: its number. */
  childDomain(parent: number): number;
  /** Record a definition an application domain has found; it holds for the ABCs added after. */
  found(definition: FoundDefinition): void;
  /**
   * ABC `index` compiled whole, the last added by default, against every ABC
   * added so far, later ones included, so a SWF's DoABCs may all be added
   * before any compiles; `hashes` are the ABCs' hashes in load order, as
   * the cache key names them.
   */
  compile(hashes?: string[], index?: number): Compiled;
  /** Method bodies of ABC `index` (the last added by default) compiled alone, as the JIT compiles each on its first call; a native, unverified or unknown one is left out. */
  compileMethods(bodies: number[], index?: number): Map<number, string>;
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
  // Whether the domain has an ABC to compile: asking before is a mistake worth a message, not a trap.
  let added = 0;
  const last = (what: string) => {
    if (added === 0) {
      throw new Error(`${what}: no ABC has been added to the domain`);
    }
  };
  // An ABC by its position among those added, -1 for the last.
  const indexOf = (index: number) => {
    if (index >= 0 && (!Number.isInteger(index) || index >= added)) {
      throw new Error(`ABC ${index}: only ${added} have been added to the domain`);
    }

    return index < 0 ? -1 : index;
  };
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
      added = 0;
      collected(wasm.domainReset(apiVersion));
    },
    add(abc, builtin = false, appDomain = 0) {
      const error = collected(wasm.domainAdd(abc, builtin, appDomain));
      if (error === 0) {
        added++;
      }

      return error;
    },
    childDomain(parent) {
      return collected(wasm.domainChild(parent));
    },
    found(d) {
      collected(wasm.domainFound(d.domain, d.nsKind, d.uri, d.name, d.abc, d.asType));
    },
    compile(hashes = [], index = -1) {
      last("compile");
      const module = wasm.domainModule(hashes.join("\n"), indexOf(index));
      const sourceMap = wasm.domainSourceMap();
      const entries = parseEntries(wasm.domainModuleEntries());
      collected(undefined);
      return { module, sourceMap, entries };
    },
    compileMethods(bodies, index = -1) {
      last("compileMethods");
      const indices = bodies.filter((b) => Number.isInteger(b) && b >= 0);
      if (indices.length === 0) {
        return new Map();
      }

      return parseEntries(collected(wasm.domainEmitEach(indices.join(","), true, indexOf(index))));
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
