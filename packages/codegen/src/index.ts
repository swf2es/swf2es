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

/** A finding as a cache key names it: the defining ABC by its hash (see FoundDefinition). */
export interface FoundKey {
  nsKind: number;
  uri: string;
  name: string;
  hash: string;
  asType: boolean;
}

/**
 * Cache key for compiled output. Browser caches, the AOT server and the JIT
 * all use this key, so their results are interchangeable. `linked` are the
 * hashes of the ABCs loaded before this one, in order, whose layouts the
 * output depends on; `found`, what its application domain was recorded to
 * find (Codegen.found), which binds its names and types too.
 */
export function cacheKey(abcHash: string, linked: string[] = [], found: FoundKey[] = []): string {
  const key = `swf2es@${COMPILER_VERSION}:${[...linked, abcHash].join("+")}`;
  if (found.length === 0) {
    return key;
  }

  // In one order whatever order they were found in; JSON keeps a URI or a
  // name that holds a separator from reading as two.
  const findings = found
    .map((f) => JSON.stringify([f.asType ? 1 : 0, f.nsKind, f.uri, f.name, f.hash]))
    .sort();
  return `${key}:found[${findings.join(",")}]`;
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
/**
 * What ABC `index`'s module depends on in the domain beyond the ABCs'
 * bytes (see Codegen.context).
 */
export interface ModuleContext {
  /** The ABCs its application domain sees, by their positions among those added, in load order. */
  abcs: number[];
  /** Its own place in `abcs`. */
  own: number;
  /**
   * The domain's log about those ABCs, in order: the lazy answers fixed so
   * far and the findings recorded, each with how many of `abcs` there were.
   */
  log: string;
}

/** A module compiled, and what compiling it fixed in the domain, to replay in its place (Codegen.replay); null where it cannot be. */
export interface LoggedModule {
  module: string;
  log: string | null;
}

export interface Codegen {
  /**
   * The identity of this codegen.wasm, a hash of its bytes that its build
   * stamps it with; null for one built without it.
   */
  readonly identity: string | null;
  /** The version at the start of an ABC block, or null if it is too short. */
  abcVersion(abc: Uint8Array): AbcVersion | null;
  /** Start a domain whose user ABCs have API version `apiVersion`: Flash Player's, 50, by default. */
  reset(apiVersion?: number): void;
  /**
   * Add an ABC, loaded into application domain `appDomain` (0, the root, by
   * default), linking it against what that domain sees of those before it;
   * 0, or the VerifyError it was rejected with (then it is not added).
   * Throws for an application domain never made, or dropped.
   */
  add(abc: Uint8Array, builtin?: boolean, appDomain?: number): number;
  /** A new application domain, a child of `parent`: its number. Throws for a `parent` never made, or dropped. */
  childDomain(parent: number): number;
  /**
   * Drop application domain `appDomain` and its descendants once nothing
   * can run their code: no other sees their ABCs, which compile no more,
   * and compact reuses the memory they took. The indices of the ABCs added
   * after them do not change, and neither does what those compile to.
   * Nothing, if `epoch` is given and the domain was reset since.
   */
  dropDomain(appDomain: number, epoch?: number): void;
  /**
   * How many times `reset` has started a domain: a host that keeps the
   * number a domain had passes it to dropDomain, which then drops nothing
   * if the domain was reset since, as when another player took the Codegen
   * over and its numbers are another domain's.
   */
  readonly epoch: number;
  /**
   * Rebuild the domain without the ABCs of dropped and evicted domains, if
   * memory would otherwise grow and they hold enough to keep it from
   * growing: whether it did. A rebuild links every live ABC again, tens of
   * milliseconds for a large application, so a host calls this when it has
   * time, as when idle; nothing else does.
   */
  compact(): boolean;
  /**
   * What the ABCs hold of codegen's memory, roughly, in bytes: the live
   * ones', and the dropped and evicted domains' that compact would free;
   * and the size of codegen's memory, which never shrinks.
   */
  usage(): { live: number; dead: number; memory: number };
  /**
   * Evict application domain `appDomain` and its descendants while the host
   * has no use for them, as once their ABCs are compiled: as dropped, but
   * reviveDomain makes one live again. compact reuses what they took
   * meanwhile, all but their findings, what was first resolved of them,
   * and their ABCs' places.
   */
  evictDomain(appDomain: number): void;
  /** Whether application domain `appDomain` is live: made, and neither evicted nor dropped. */
  isLive(appDomain: number): boolean;
  /**
   * Make evicted application domain `appDomain` live again, with its evicted
   * ancestors, the first of them a child of a live domain: given all their
   * ABCs again by their indices, as they were added, their ABCs link as
   * they did, by one rebuild at most, and what they found holds. Throws if
   * they cannot be.
   */
  reviveDomain(appDomain: number, abcs: Map<number, Uint8Array>): void;
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
  /**
   * ABC `index`'s module alone, as `compile` writes it, for a host that
   * loads it and needs neither its source map nor its entries: writing
   * those too would add a large ABC's worth to codegen's memory, which
   * never shrinks.
   */
  compileModule(hashes?: string[], index?: number): string;
  compileMethods(bodies: number[], index?: number): Map<number, string>;
  /**
   * What ABC `index`'s module depends on beyond the ABCs' bytes, for a
   * cache key: besides the ABCs its domain sees, what the domain has
   * fixed of what resolves lazily, which a later ABC in an ancestor would
   * change were it first asked now. Null for an ABC never added.
   */
  context(index?: number): ModuleContext | null;
  /** compileModule, with what the compile fixed in the domain (see replay). */
  compileModuleLogged(hashes?: string[], index?: number): LoggedModule;
  /**
   * Fix in the domain what compiling ABC `index` did, from the log
   * compileModuleLogged gave with its module, in place of compiling it:
   * the domain is then as the compile would have left it, if its context
   * is the one that compile had. False if the log is malformed or an
   * entry fails, after doing those before it.
   */
  replay(log: string, index?: number): boolean;
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
  // ABC `index`'s module, its source map and entries kept for `keep`. A
  // module is never empty: the ABC was of a dropped application domain.
  const moduleOf = (hashes: string[], index: number, keep: boolean) => {
    // Only the hashes the module names: joining every ABC's for each
    // compile took megabytes of codegen's memory a few thousand loads on.
    const at = indexOf(index);
    const own = at < 0 ? added - 1 : at;
    const linked = collected(wasm.domainLinked(at));
    const named = [hashes[own] ?? ""];
    for (const i of linked ? linked.split(",") : []) {
      named.push(hashes[Number(i)] ?? "");
    }

    const module = collected(wasm.domainModule(named.join("\n"), at, keep, true));
    if (module === "") {
      throw new Error(`ABC ${index}: its application domain was dropped`);
    }

    return module;
  };
  const stamps = WebAssembly.Module.customSections(module, "swf2es.build");
  const identity = stamps.length ? String.fromCharCode(...new Uint8Array(stamps[0])) : null;
  let epoch = 0;
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
    identity,
    abcVersion(abc) {
      const packed = collected(wasm.abcVersion(abc));
      return packed < 0 ? null : { major: packed >>> 16, minor: packed & 0xffff };
    },
    get epoch() {
      return epoch;
    },
    reset(apiVersion = 50) {
      added = 0;
      epoch++;
      collected(wasm.domainReset(apiVersion));
    },
    add(abc, builtin = false, appDomain = 0) {
      const error = collected(wasm.domainAdd(abc, builtin, appDomain));
      if (error < 0) {
        throw new Error(`application domain ${appDomain}: never made, or dropped`);
      }

      if (error === 0) {
        added++;
      }

      return error;
    },
    childDomain(parent) {
      const domain = collected(wasm.domainChild(parent));
      if (domain < 0) {
        throw new Error(`application domain ${parent}: never made, or dropped`);
      }

      return domain;
    },
    dropDomain(appDomain, of = epoch) {
      if (of === epoch) {
        collected(wasm.domainDrop(appDomain));
      }
    },
    evictDomain(appDomain) {
      collected(wasm.domainEvict(appDomain));
    },
    usage() {
      const [live, dead, memory] = collected(wasm.domainUsage()).split(" ").map(Number);
      return { live, dead, memory };
    },
    compact() {
      // A rebuild makes new tables while the old are live: what earlier
      // calls left is collected first, and the old tables once it is done,
      // before the next call's allocations would grow memory past them.
      if (!collected(wasm.domainWantsCompact())) {
        return false;
      }

      wasm.__collect();
      calls = 0;
      if (!wasm.domainCompact()) {
        return false;
      }

      wasm.__collect();
      size = wasm.memory.buffer.byteLength;
      calls = 0;
      return true;
    },
    isLive(appDomain) {
      return collected(wasm.domainState(appDomain)) === 0;
    },
    reviveDomain(appDomain, abcs) {
      // Its ABCs' bytes are copied into the compiler only if a rebuild let go of them.
      let revived = collected(wasm.domainRevive(appDomain));
      if (revived < 0) {
        for (const [index, bytes] of abcs) {
          const error = collected(wasm.domainRestore(index, bytes));
          if (error !== 0) {
            throw new Error(`ABC ${index}: not of an evicted domain, or rejected (${error})`);
          }
        }

        revived = collected(wasm.domainRevive(appDomain));
      }

      if (revived < 0) {
        throw new Error(
          `application domain ${appDomain}: not evicted, its parent not live, or an ABC of it not given`,
        );
      }

      if (revived > 0) {
        wasm.__collect();
        size = wasm.memory.buffer.byteLength;
        calls = 0;
      }
    },
    found(d) {
      collected(wasm.domainFound(d.domain, d.nsKind, d.uri, d.name, d.abc, d.asType));
    },
    compile(hashes = [], index = -1) {
      last("compile");
      // Each part a call of its own, collected after it: the module's garbage
      // is gone before its entries are written.
      const module = moduleOf(hashes, index, true);
      const sourceMap = collected(wasm.domainSourceMap());
      const entries = parseEntries(collected(wasm.domainModuleEntries()));
      return { module, sourceMap, entries };
    },
    compileModule(hashes = [], index = -1) {
      last("compileModule");
      return moduleOf(hashes, index, false);
    },
    context(index = -1) {
      if (added === 0) {
        return null;
      }

      const text = collected(wasm.domainContext(indexOf(index)));
      if (text === "") {
        return null;
      }

      const [abcs, own, ...log] = text.split("\n");
      return {
        abcs: abcs ? abcs.split(",").map(Number) : [],
        own: Number(own),
        log: log.join("\n"),
      };
    },
    compileModuleLogged(hashes = [], index = -1) {
      last("compileModuleLogged");
      const mark = wasm.domainLogMark();
      const module = moduleOf(hashes, index, false);
      const log = collected(wasm.domainLogSince(mark, indexOf(index)));
      return { module, log: log === "!" ? null : log };
    },
    replay(log, index = -1) {
      last("replay");
      return collected(wasm.domainReplay(log, indexOf(index)));
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
