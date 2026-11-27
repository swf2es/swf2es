/**
 * Compiles ABC and AVM1 bytecode to ES modules.
 *
 * The compiler itself is Zig (zig/), built to codegen.wasm, whose exports
 * zig.ts binds. This wrapper instantiates it and gives its exports their
 * types. The same wasm runs as the browser JIT
 * (a module per ABC as its SWF loads) and as the ahead-of-time compiler,
 * so both produce identical output. See docs/architecture/overview.md.
 */
import { AIR_API_VERSION, API_VERSION, checkApiVersion, isAirApiVersion } from "@swf2es/format";
import { KeyChains, type KeyContext } from "./keys.js";
import {
  type CodegenExports,
  CodegenOutOfMemory,
  CodegenPanic,
  checkExports,
  instantiate,
  recoveryInstance,
} from "./zig.js";

export { KeyChains, type KeyContext, type KeyLog } from "./keys.js";
export { hex, sha256Here } from "./sha256.js";

/** Bumped whenever generated code or the runtime ABI it calls changes. */
export const COMPILER_VERSION = "0.0.0";

// The API versions the player and the swf2es command reset the compiler
// with, which module cache keys name: Flash Player's, and AIR's, whose
// series has the names Flash Player's leaves out. format's, which the
// runtime takes too.
export { AIR_API_VERSION, API_VERSION };

/** The ABCs added to a compiler, by their indices: each one's hash, and whether it was added as a library. */
export interface AddedAbcs {
  readonly hashes: readonly string[];
  readonly builtins: readonly boolean[];
}

/**
 * The log's entries made while only the first `count` ABCs, the libraries,
 * were added, as a key names them: by the SHA-256 of libraryLog's text,
 * taken once, since they are the same in every later module's context.
 */
export interface LibraryDigest {
  count: number;
  digest: string;
}

/** The text whose SHA-256 is a LibraryDigest's, for ABC `index`, any added after the first `count`. */
export function libraryLog(codegen: Codegen, index: number, count: number): string {
  return codegen.context(index, 0, count)?.log ?? "";
}

/**
 * The text of ABC `index`'s module cache key, whose UTF-8's SHA-256 is the
 * key: what the module depends on, the compiler's identity, the API
 * version (only its series for a module whose domain sees libraries alone,
 * whose names take their versions from their marks and the series, so that
 * SWFs of several versions share the libraries' modules), every ABC its
 * domain sees, by hash and whether it is a library, those added after it
 * included, its own place among them, and the compiler's log about them
 * (see Codegen.context), the libraries' part by its digest once taken and
 * the rest by the chained digests of its blocks of entries but the last
 * few (see Codegen.keyContext). The player's module cache and the swf2es
 * command both key by it, so that the command's modules are the cache's.
 * Null where there is no context.
 */
export function moduleKey(
  codegen: Codegen,
  index: number,
  abcs: AddedAbcs,
  libraries: LibraryDigest | null,
): string | null {
  const context = codegen.keyContext(index, libraries?.count ?? 0);
  if (!context) {
    return null;
  }

  const version = codegen.apiVersion;
  const ofLibraries = context.abcs.every((i) => abcs.builtins[i]);
  return JSON.stringify({
    compiler: codegen.identity,
    api: ofLibraries ? (isAirApiVersion(version) ? "AIR" : "Flash Player") : version,
    abcs: context.abcs.map((i) => `${abcs.builtins[i] ? "builtin " : ""}${abcs.hashes[i]}`),
    own: context.own,
    libraries,
    blocks: context.blocks,
    log: context.rest,
  });
}

/**
 * A SWF's AVM1 action blocks, as format's readActions lists them: the SWF's
 * version and each block's range in its decompressed bytes.
 */
export interface ActionBlocks {
  readonly version: number;
  readonly blocks: readonly { readonly offset: number; readonly length: number }[];
}

/** What a SWF's action blocks compile to: one module, and each block's entry in it. */
export interface CompiledActions {
  module: string;
  /** By block index: the block's entry in the module, as it compiles alone. */
  entries: string[];
  /** By key, each unit in the module's units, as it compiles alone. */
  units: Map<string, ModuleUnit>;
}

/**
 * Where control goes on in a unit, as V.far is called: an offset in the
 * SWF's decompressed bytes, where the region it goes on in ends, where its
 * actions' bytes end, and whether it runs as a SWF 5's function. The
 * module's units are keyed by these, joined with commas.
 */
export interface ActionUnit {
  readonly at: number;
  readonly end: number;
  readonly bound: number;
  readonly five: boolean;
}

/**
 * A unit's code, and what it depends on: it runs as well for any region
 * that ends at or past `high` whose actions' bytes end at or past `reach`,
 * -1 for only the one it was compiled for.
 */
export interface CompiledUnit {
  code: string;
  high: number;
  reach: number;
}

/** A unit of a module's units, and what it was compiled for. */
export interface ModuleUnit extends CompiledUnit {
  unit: ActionUnit;
}

/**
 * The text of the module cache key of a SWF's AVM1 module, whose UTF-8's
 * SHA-256 is the key: the compiler's identity, the SWF's version, which
 * picks the operations its code calls, and `hash`, the SHA-256 of the
 * SWF's decompressed bytes, which hold its blocks. An AVM1 module links to
 * nothing, so nothing else goes in.
 */
export function actionsKey(codegen: Codegen, hash: string, version: number): string {
  return JSON.stringify({ compiler: codegen.identity, avm1: version, swf: hash });
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
  /** By method body index: the body's entry in the module's F. */
  entries: Map<number, string>;
}

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

/** How long compactStep may go on: as an IdleDeadline, the milliseconds left. */
export interface CompactDeadline {
  timeRemaining(): number;
}

/** What compactStep did (see Codegen.compactStep). */
export type CompactProgress = "none" | "moving" | "done";

/** Why a move compactStep started was given up, the domain left as it was. */
export type MoveAbort =
  /** The spare instance panicked, trapped or ran out of memory. */
  | "spare"
  /** The spare refused: the domain too large to move, or a part that did not load, rebuild or replay. */
  | "refused"
  /** A call meanwhile could not be journaled, so the spare could not catch up. */
  | "unjournaled"
  /** The domain was reset, recovered from a panic, or rebuilt in place meanwhile. */
  | "superseded";

/**
 * compactStep's moves: started, completed, and given up by why; and of the
 * last one completed, the calls replayed into its spare after its rebuild,
 * and the bytes of its snapshot, which recovery keeps as its checkpoint.
 */
export interface MoveCounts {
  started: number;
  completed: number;
  aborted: Record<MoveAbort, number>;
  lastCaughtUp: number;
  lastSavedBytes: number;
}

/**
 * The compiler. ABCs are added to a domain in the order the SWF loads them
 * (the builtins first), and the last one added compiles to its module,
 * byte for byte the same however the compiler got there.
 */
export interface Codegen {
  /**
   * The identity of this codegen.wasm, a hash of its bytes that its build
   * stamps it with; null for one built without it.
   */
  readonly identity: string | null;
  /** The version at the start of an ABC block, or null if it is too short. */
  abcVersion(abc: Uint8Array): AbcVersion | null;
  /**
   * Start a domain whose user ABCs have API version `apiVersion`: Flash
   * Player's, API_VERSION, by default, or AIR's, AIR_API_VERSION; one
   * that is neither series' (checkApiVersion) is a RangeError.
   */
  reset(apiVersion?: number): void;
  /** The API version of the last reset. */
  readonly apiVersion: number;
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
   * growing, or memory is far above what the live ones need: whether it
   * did. Done in a new instance of the compiler, made ahead, which takes
   * the old one's place, so that its memory goes with it, where that takes
   * less memory or a rebuild in place would not fit; else in place, only
   * where the new tables fit beside the old. A rebuild links every live
   * ABC again and verifies them again, seconds for a large application, so
   * a host calls this when it has time, as when idle; nothing else does.
   */
  compact(): boolean;
  /**
   * compact a part at a time, for a host that goes on compiling meanwhile:
   * a move into the spare instance is snapshotted, loaded and rebuilt there
   * while `deadline.timeRemaining()` is above 0 (one part at least), the
   * calls made meanwhile replayed into it, and it takes this instance's
   * place once it has caught up. "moving" while some is left, to be called
   * again; "done" once a rebuild finished in this call; "none" if none was
   * due, or the move was given up, the domain left as it was. Only a small
   * domain is rebuilt in place, in one call; a larger one moves.
   */
  compactStep(deadline: CompactDeadline): CompactProgress;
  /**
   * What the ABCs hold of codegen's memory, roughly, in bytes: the live
   * ones', and the dropped and evicted domains' that compact would free;
   * the size of codegen's memory, which grows and never shrinks but when
   * compact moves the domain to a new instance; how many such moves
   * failed, each leaving the domain as it was, rebuilt in place if at all;
   * compactStep's moves; and what the recovery from a panic holds outside
   * codegen's memory: its checkpoint and the inputs journaled since, in
   * bytes.
   */
  usage(): {
    live: number;
    dead: number;
    memory: number;
    failedMoves: number;
    moves: MoveCounts;
    recovery: number;
  };
  /** The size of codegen's memory in bytes, as usage gives it: cheap, for a host that shows it often. */
  memoryBytes(): number;
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
  /**
   * ABC `index`'s module alone, as `compile` writes it, for a host that
   * loads it and needs neither its source map nor its entries: writing
   * those too would add a large ABC's worth to codegen's memory, which
   * never shrinks.
   */
  compileModule(hashes?: string[], index?: number): string;
  /**
   * What ABC `index`'s module depends on beyond the ABCs' bytes, for a
   * cache key: besides the ABCs its domain sees, what the domain has
   * fixed of what resolves lazily, which a later ABC in an ancestor would
   * change were it first asked now. Its log only of the entries made with
   * more than `after` ABCs added, and `upTo` at most unless negative. Null
   * for an ABC never added.
   */
  context(index?: number, after?: number, upTo?: number): ModuleContext | null;
  /**
   * ABC `index`'s context as a module key names it, the log's entries
   * made with `after` ABCs added or fewer left out: the log by the chained
   * digests of its blocks of entries, those made before the last ABC was
   * added, and the text of the entries after them. Each application
   * domain keeps its last digest, so a key reads and digests only the
   * entries made since the last, or since its parent's. The same domain
   * gives the same however its keys were taken. Null for an ABC never
   * added, or of a domain not live.
   */
  keyContext(index?: number, after?: number): KeyContext | null;
  /**
   * A string that changes whenever a context might: a host that took one
   * and finds this the same since need not take it again.
   */
  revision(): string;
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
  /**
   * A SWF's AVM1 action blocks compiled to one module, `bytes` the SWF's
   * decompressed bytes, which the blocks' ranges are of (format's
   * `Swf.bytes`), with each block's entry in it. Needs no domain: AVM1 code
   * links to nothing.
   */
  compileActions(bytes: Uint8Array, actions: ActionBlocks): CompiledActions;
  /** compileActions' module alone. */
  compileActionsModule(bytes: Uint8Array, actions: ActionBlocks): string;
  /**
   * Blocks of a SWF compiled alone, by index, as a JIT may compile each
   * when it first runs: each byte for byte its entry in the SWF's module.
   * An index with no block is left out.
   */
  compileActionBlocks(
    bytes: Uint8Array,
    actions: ActionBlocks,
    blocks: number[],
  ): Map<number, string>;
  /**
   * A unit of a SWF compiled alone, as V.far asks for it when control first
   * goes on there: byte for byte its entry in the module's units.
   */
  compileActionUnit(bytes: Uint8Array, actions: ActionBlocks, unit: ActionUnit): CompiledUnit;
  /**
   * Let go of the copy of a SWF compileActionBlocks and compileActionUnit
   * keep, as the host lets the SWF go; it is let go too once `bytes` are
   * collected, and when blocks or units of other SWFs are asked for since.
   */
  releaseActions(bytes: Uint8Array): void;
  /** How many SWFs compileActionBlocks and compileActionUnit keep a copy of, and how many times they have copied one in. */
  heldActions(): { held: number; copies: number };
}

/**
 * Instantiate the compiler from a compiled codegen.wasm module. Loading the
 * bytes is left to the caller (fetch in browsers, fs in node), which keeps
 * this package free of I/O. The file ships as `@swf2es/codegen/codegen.wasm`.
 */
export async function createCodegen(module: WebAssembly.Module): Promise<Codegen> {
  checkExports(module);
  let wasm = await instantiate(module);
  const version = wasm.compilerVersion();
  if (version !== COMPILER_VERSION) {
    throw new Error(
      `codegen.wasm is version ${version} but the wrapper expects ${COMPILER_VERSION}`,
    );
  }

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
    const linked = wasm.domainLinked(at);
    const named = [hashes[own] ?? ""];
    for (const i of linked ? linked.split(",") : []) {
      named.push(hashes[Number(i)] ?? "");
    }

    // Its bytes decoded here: lifted as a string, a module of megabytes took
    // longer than compiling it. The emitter writes only ASCII, which decodes
    // alike either way, and to a string the engine keeps a byte a character.
    // A large ABC's module comes a part at a time, each part's arena given
    // back as the next is written (see domainModuleBytes).
    const parts = [
      handed(wasm.domainModuleBytes(named.join("\n"), at, keep, true), wasm.outputLength()),
    ];
    while (!wasm.domainModuleDone()) {
      parts.push(handed(wasm.domainModuleMoreBytes(), wasm.outputLength()));
    }

    const module = parts.length === 1 ? parts[0] : parts.join("");
    if (module === "") {
      throw new Error(`ABC ${index}: its application domain was dropped`);
    }

    return module;
  };
  const compiled = (hashes: string[], index: number, keep: boolean) =>
    recordChanges(() => moduleOf(hashes, index, keep));
  const ranges = (actions: ActionBlocks) =>
    [
      Int32Array.from(actions.blocks, (b) => b.offset),
      Int32Array.from(actions.blocks, (b) => b.length),
    ] as const;
  // The SWFs whose blocks or units compileActionBlocks and compileActionUnit
  // compile, which wasm holds by a handle each: the few used last, so that
  // blocks and units of SWFs that alternate do not copy them in again, each
  // let go as its bytes are collected.
  const holding = new WeakMap<Uint8Array, { handle: number; actions: ActionBlocks }>();
  const holds: number[] = [];
  let handles = 0;
  let copies = 0;
  const release = (handle: number) => {
    const at = holds.indexOf(handle);
    if (at >= 0) {
      holds.splice(at, 1);
      // Also called from the finalization registry, which must not throw:
      // a dead instance's holds went with it.
      try {
        wasm.actionsRelease(handle);
      } catch (error) {
        if (!(error instanceof CodegenPanic)) {
          throw error;
        }
      }
    }
  };
  const collectedSwfs = new FinalizationRegistry<number>(release);
  const hold = (bytes: Uint8Array, actions: ActionBlocks): number => {
    const known = holding.get(bytes);
    if (known !== undefined && known.actions === actions && holds.includes(known.handle)) {
      holds.splice(holds.indexOf(known.handle), 1);
      holds.push(known.handle);
      return known.handle;
    }

    if (known !== undefined) {
      release(known.handle);
      collectedSwfs.unregister(known);
    }

    const handle = ++handles;
    const [offsets, lengths] = ranges(actions);
    wasm.actionsHold(handle, bytes, offsets, lengths);
    copies++;
    const record = { handle, actions };
    holding.set(bytes, record);
    collectedSwfs.register(bytes, handle, record);
    holds.push(handle);
    while (holds.length > HELD_SWFS) {
      release(holds[0]);
    }

    return handle;
  };
  const actionsModule = (bytes: Uint8Array, actions: ActionBlocks, keep: boolean) => {
    const [offsets, lengths] = ranges(actions);
    const address = wasm.actionsModuleBytes(bytes, offsets, lengths, actions.version, keep);
    return handed(address, wasm.outputLength());
  };
  // UTF-8 a call handed out in codegen's memory, not copied (see handOut in
  // zig/src/root.zig), decoded before anything else calls in: the next
  // call may grow memory, and gives the last one's arena back.
  const handed = (address: number, length: number) =>
    length === 0 ? "" : utf8.decode(view(address, length));
  // `length` bytes at `address` in codegen's memory, read inside the panic guard (see zig.ts).
  const view = (address: number, length: number) => wasm.view(address, length);
  const stamps = WebAssembly.Module.customSections(module, "swf2es.build");
  const identity = stamps.length ? String.fromCharCode(...new Uint8Array(stamps[0])) : null;
  let epoch = 0;
  let revisionEpoch = 0;
  let apiVersion = API_VERSION;
  // Read where they are in codegen's memory, digested before the next call in.
  const chains = new KeyChains({
    header(index) {
      const address = wasm.domainKeyHeaderBytes(index);
      return address === 0 ? "" : handed(address, wasm.outputLength());
    },
    parent: (appDomain) => wasm.domainParent(appDomain),
    fork: (appDomain) => wasm.domainKeyFork(appDomain),
    log(appDomain, after, from, to, block, filled) {
      const address = wasm.domainKeyLogBytes(appDomain, after, from, to, block, filled);
      return address === 0 ? null : view(address, wasm.outputLength());
    },
  });
  // Snapshot the inputs of a successful Zig rebuild. Recovery then repeats that same generation
  // and can release older findings, compiles and bytes of evicted ABCs.
  interface Checkpoint {
    state: Uint8Array;
    abcs: Map<number, Uint8Array>;
  }
  let checkpoint: Checkpoint | null = null;
  const saveCheckpoint = (): Checkpoint => {
    const at = wasm.domainSaveBytes();
    const state = view(at, wasm.outputLength()).slice();
    const abcs = new Map<number, Uint8Array>();
    for (let i = 0; i < added; i++) {
      const at = wasm.domainSavedAbcBytes(i);
      if (at) {
        abcs.set(i, view(at, wasm.outputLength()).slice());
      }
    }
    return { state, abcs };
  };
  const loadCheckpoint = (into: typeof wasm, saved: Checkpoint, recovery: boolean) => {
    const loaded = recovery ? into.loadCheckpointState(saved.state) : into.domainLoad(saved.state);
    if (!loaded) {
      return false;
    }
    for (const [index, abc] of saved.abcs) {
      if (into.domainLoadAbc(index, abc) !== 0) {
        return false;
      }
    }
    return into.domainLoadRebuild();
  };
  // The rebuild domainCompact, domainRevive or domainLoadRebuild started in
  // `into`, a part a call, each part's arena given back as the next starts
  // (see domainRebuildStep): whether it was done.
  const finishRebuild = (into: typeof wasm) => {
    let step = into.domainRebuildStep();
    while (step === 0) {
      step = into.domainRebuildStep();
    }

    return step > 0;
  };
  const rebuild = (into = wasm, saved: Checkpoint | null = null, optional = false) => {
    let done: boolean;
    try {
      if (!saved) {
        saved = saveCheckpoint();
      }
      done = finishRebuild(into);
    } catch (error) {
      if (!(error instanceof CodegenPanic)) {
        into.abandonRebuild();
        if (optional && error instanceof CodegenOutOfMemory) {
          return false;
        }
      }

      throw error;
    }

    if (done && saved) {
      // The journal a move under way catches up from is cleared below.
      if (into === wasm) {
        abortMove("superseded");
      }

      moveRefused = false;
      checkpoint = saved;
      journal.clear();
      restores.clear();
      for (const domain of journalDomains.values()) {
        domain.entries = undefined;
      }
      replayable = true;
    }

    return done;
  };
  // A second instance of the compiler, made ahead as instantiating is
  // asynchronous, that the next rebuild is done in (see moved): wasm memory
  // never shrinks, so one done in place keeps, for good, as much as the
  // dead tables and the old and the new took together. Made only once a
  // move will be due before long (WANT_Spare), not for every compiler, and
  // taken by the move; and how many moves failed, which usage tells.
  let spare: typeof wasm | null = null;
  let making = false;
  let failedMoves = 0;
  // The move compactStep has under way, a part at a time (see Move), and what came of its moves.
  let move: Move | null = null;
  const moves: MoveCounts = {
    started: 0,
    completed: 0,
    aborted: { spare: 0, refused: 0, unjournaled: 0, superseded: 0 },
    lastCaughtUp: 0,
    lastSavedBytes: 0,
  };
  // Whether the spare refused a move as too large, until the next rebuild: a large domain then rebuilds in place.
  let moveRefused = false;
  // The drops and evictions so far, and how many there must be before
  // compactStep starts a move again after one was given up as failed: the
  // same domain would likely fail the same way.
  let lettings = 0;
  let retryAt = 0;
  const abortMove = (why: MoveAbort) => {
    if (move !== null) {
      move = null;
      moves.aborted[why]++;
      if (why !== "superseded") {
        retryAt = lettings + RETRY_Lettings;
      }

      if (why === "spare" || why === "refused") {
        failedMoves++;
      }
    }
  };
  const prepare = () => {
    if (spare === null && !making) {
      making = true;
      instantiate(module).then(
        (made) => {
          spare = made;
          making = false;
        },
        () => {
          making = false;
        },
      );
    }
  };
  // The domain rebuilt in `into`, a new instance, from what this one saves
  // of it and its live ABCs' bytes, read where they are: whether it was.
  const rebuiltIn = (into: typeof wasm) => {
    const saved = saveCheckpoint();
    return loadCheckpoint(into, saved, false) && rebuild(into, saved);
  };
  // The domain rebuilt in the spare instance, which then takes this one's
  // place, whose memory goes with it: whether it was. One that failed, or
  // trapped as its memory could not grow, is let go of, the domain left
  // here as it was, and another made.
  const moved = () => {
    const into = spare;
    if (into === null) {
      return false;
    }

    spare = null;
    let done = false;
    try {
      done = rebuiltIn(into);
    } catch {
      done = false;
    }

    if (!done) {
      failedMoves++;
      return false;
    }

    // The held SWFs' copies were the old instance's (see hold).
    holds.length = 0;
    wasm = into;
    return true;
  };
  // When the compiler panics, its instance is dead (CodegenPanic). Recovery reads nothing of it: the calls
  // that changed the domain are journaled here, in order, and replayed into
  // a fresh instance, which is the same domain by determinism and takes
  // the dead one's place; the call that panicked is left out. If the replay
  // panics too, or a compile's log cannot be replayed, there is no second
  // attempt: the domain is lost (see fresh).
  type Entry =
    | {
        kind: "add";
        abc: Uint8Array;
        builtin: boolean;
        appDomain: number;
        /** Its index, or -1 where it was rejected. */
        index: number;
        error: number;
      }
    | { kind: "child"; parent: number }
    | { kind: "drop" | "evict" | "revive"; appDomain: number }
    | { kind: "restore"; index: number; bytes: Uint8Array }
    | { kind: "found"; definition: FoundDefinition }
    /** A compile's log entries of ABCs of one domain, four words each: kind, ABC, a, b. */
    | { kind: "log"; words: Uint32Array };
  interface JournalDomain {
    id: number;
    parent?: JournalDomain;
    children?: Set<JournalDomain>;
    entries?: Entry[];
  }
  // A move compactStep makes a part at a time: the spare it rebuilds in,
  // the snapshot it rebuilds, the calls journaled since, how many of those
  // the spare has replayed and where in one it is; the bytes of the ABCs
  // revivals since restored in it, copied once; the saved ABCs not yet
  // given to it; its phase; and the slices it has spent catching up.
  interface Move {
    into: Bound;
    saved: Checkpoint;
    entries: Entry[];
    replayed: number;
    /** Where in the log entry being replayed, a compile's, the spare is. */
    word: number;
    restored: Map<number, Uint8Array>;
    abcs: IterableIterator<[number, Uint8Array]> | null;
    phase: "load" | "abcs" | "rebuild" | "catch up";
    catchUp: number;
  }
  const journalDomains = new Map<number, JournalDomain>();
  const journal = new Set<Entry>();
  // What the checkpoint and the journal hold, their bytes and strings' units twice.
  const recoveryBytes = () => {
    let bytes = 0;
    if (checkpoint) {
      bytes += checkpoint.state.byteLength;
      for (const abc of checkpoint.abcs.values()) {
        bytes += abc.byteLength;
      }
    }

    for (const entry of journal) {
      switch (entry.kind) {
        case "add":
          bytes += entry.abc.byteLength;
          break;
        case "restore":
          bytes += entry.bytes.byteLength;
          break;
        case "log":
          bytes += entry.words.byteLength;
          break;
        case "found":
          bytes += (entry.definition.uri.length + entry.definition.name.length) * 2;
          break;
      }
    }

    return bytes;
  };
  const restores = new Map<number, Entry>();
  const abcDomains: number[] = [];
  // Each ABC's length, by its index, which a replay of its verification takes time in proportion to.
  const abcLengths: number[] = [];
  let replayable = true;
  const journaled = (entry: Entry, owner = 0) => {
    const id = owner | 0;
    if (id !== 0) {
      const domain = journalDomains.get(id);
      if (!domain) {
        // The native call ignored a domain that was dropped or never created.
        return;
      }

      domain.entries ??= [];
      domain.entries.push(entry);
    }

    journal.add(entry);
    move?.entries.push(entry);
  };
  // The target is absolute so dropping a child preserves work its compiles did on its ancestors.
  const journalLog = (mark: number) => {
    const at = wasm.journalBytes(mark);
    if (at === 0) {
      return false;
    }
    const count = wasm.outputLength() / 4;
    if (!count) {
      return true;
    }
    // Packed, a run of entries of one domain's ABCs to a journal entry, so
    // that a long session's logs take their words and little more.
    const bytes = view(at, count * 4);
    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, count).slice();
    let start = 0;
    for (let i = 4; i <= count; i += 4) {
      const owner = abcDomains[words[start + 1]];
      if (i === count || abcDomains[words[i + 1]] !== owner) {
        journaled({ kind: "log", words: words.subarray(start, i) }, owner);
        start = i;
      }
    }

    return true;
  };
  function recordChanges<T>(call: () => T): T {
    if (!replayable) {
      return call();
    }

    const mark = wasm.domainLogMark();
    let result: T;
    try {
      result = call();
    } catch (error) {
      // A stepped verifier can have logged its start without finishing. Replaying
      // that entry would resolve more of the domain than the interrupted compile did.
      if (!(error instanceof CodegenPanic)) {
        try {
          replayable = wasm.domainLogMark() === mark;
        } catch {
          replayable = false;
        }
      }

      throw error;
    }

    // A missing suffix makes recovery unsafe until the next successful
    // checkpoint. A panic reading it leaves the journal as it was before the
    // compile, which recovery then gives back, the compile's changes with
    // the dead instance: only another failure suspends recovery.
    try {
      replayable = journalLog(mark);
    } catch (error) {
      if (!(error instanceof CodegenPanic)) {
        replayable = false;
      }

      throw error;
    }

    return result;
  }
  // Whether application domain `d` is `own` or one of its ancestors.
  const inChain = (d: number, own: number) => {
    for (let at = journalDomains.get(own | 0); at; at = at.parent) {
      if (at.id === d) {
        return true;
      }
    }

    return d === 0 && own >= 0;
  };
  const forgetDropped = (appDomain: number) => {
    const root = journalDomains.get(appDomain | 0);
    if (!root) {
      return;
    }

    root.parent?.children?.delete(root);
    const pending = [root];
    for (const domain of pending) {
      if (domain.children) {
        for (const child of domain.children) {
          pending.push(child);
        }
      }

      if (domain.entries) {
        for (const entry of domain.entries) {
          if (entry.kind === "add" && entry.index >= 0) {
            entry.abc = EMPTY_ABC;
          } else {
            journal.delete(entry);
            if (entry.kind === "restore") {
              restores.delete(entry.index);
            }
          }
        }
      }

      journalDomains.delete(domain.id);
    }
  };
  // Replay `entry` into `into`: whether it started a rebuild there, which
  // only a revival `stepped` does (domainRevive's 2), for domainRebuildStep
  // to finish before the next. Any refusal is a divergence, and throws.
  const replayOne = (into: Bound, entry: Entry, stepped: boolean): boolean => {
    switch (entry.kind) {
      case "add":
        if (into.domainAdd(entry.abc, entry.builtin, entry.appDomain) !== entry.error) {
          throw new Error("a journaled ABC did not replay");
        }
        break;
      case "child":
        into.domainChild(entry.parent);
        break;
      case "drop":
        into.domainDrop(entry.appDomain);
        break;
      case "evict":
        into.domainEvict(entry.appDomain);
        break;
      case "restore":
        if (into.domainRestore(entry.index, entry.bytes) !== 0) {
          throw new Error("a journaled ABC did not restore");
        }
        break;
      case "revive": {
        // 1, or 2 stepped, where `into` rebuilt since the domain was
        // evicted, as a move's spare has, or recovery from the checkpoint
        // a move left: the restores journaled before give it the ABCs that
        // rebuild let go of, and it links them again.
        const revived = into.domainRevive(entry.appDomain, stepped);
        if (revived < 0) {
          throw new Error("a journaled domain did not revive");
        }

        return revived === 2;
      }
      case "found": {
        const d = entry.definition;
        into.domainFound(d.domain, d.nsKind, d.uri, d.name, d.abc, d.asType);
        break;
      }
      case "log": {
        const w = entry.words;
        for (let i = 0; i < w.length; i += 4) {
          if (!into.replayEntry(w[i], w[i + 1], w[i + 2], w[i + 3])) {
            throw new Error(`a compile's log did not replay for ABC ${w[i + 1]}`);
          }
        }

        break;
      }
    }

    return false;
  };
  const replayInto = (into: Bound) => {
    if (checkpoint) {
      if (!loadCheckpoint(into, checkpoint, true) || !finishRebuild(into)) {
        throw new Error("the compiler checkpoint did not restore");
      }
    } else {
      into.domainReset(apiVersion);
    }

    // Any refusal is a divergence: recovery fails, and the domain is lost.
    for (const entry of journal) {
      replayOne(into, entry, false);
    }
  };
  const recover = (): boolean => {
    // A move's spare was to catch up from the journal this replaces.
    abortMove("superseded");
    if (!replayable) {
      return false;
    }

    let into: typeof wasm;
    try {
      into = spare ?? recoveryInstance(module);
      spare = null;
      replayInto(into);
    } catch {
      replayable = false;
      return false;
    }

    // Pruning dropped domains can reuse a native log position. Invalidate
    // outstanding cache reads even when replay produces the same native revision.
    revisionEpoch++;
    // The held SWFs' copies, and the key chains' digests, were the dead instance's.
    holds.length = 0;
    chains.clear();
    wasm = into;
    return true;
  };
  // A move compactStep makes a part at a time (see Move): begun from a
  // snapshot of this instance, as a move by compact is, and never reading
  // this instance again, while the host goes on with it, each call it
  // makes journaled and replayed into the spare once the spare has rebuilt.
  const startMove = (into: Bound): boolean => {
    let saved: Checkpoint;
    try {
      saved = saveCheckpoint();
    } catch (error) {
      if (error instanceof CodegenOutOfMemory) {
        spare = into;
        return false;
      }

      throw error;
    }

    // Parts that block the host for little: a part's time is its garbage's, but for one large method's verification.
    into.domainRebuildBudget(MOVE_PartBudget);
    move = {
      into,
      saved,
      entries: [],
      replayed: 0,
      word: 0,
      restored: new Map(),
      abcs: null,
      phase: "load",
      catchUp: 0,
    };
    moves.started++;
    return true;
  };
  // The spare, rebuilt and caught up, takes this instance's place, as a
  // recovery's does, and the snapshot it rebuilt is the checkpoint, the
  // calls since it the journal.
  const swapMove = (m: Move) => {
    move = null;
    moves.completed++;
    const kept = m.entries.filter((entry) => journal.has(entry));
    moves.lastCaughtUp = kept.length;
    moves.lastSavedBytes = m.saved.state.length;
    for (const abc of m.saved.abcs.values()) {
      moves.lastSavedBytes += abc.length;
    }

    journal.clear();
    restores.clear();
    for (const entry of kept) {
      journal.add(entry);
      if (entry.kind === "restore" && !restores.has(entry.index)) {
        restores.set(entry.index, entry);
      }
    }

    for (const domain of journalDomains.values()) {
      const own = domain.entries?.filter((entry) => journal.has(entry));
      domain.entries = own?.length ? own : undefined;
    }

    checkpoint = m.saved;
    moveRefused = false;
    revisionEpoch++;
    holds.length = 0;
    chains.clear();
    wasm = m.into;
  };
  // One part of the move: a call into the spare, or the swap. Whatever the
  // spare throws, a panic or running out of memory included, gives the
  // move up, never this instance, which goes on as it was.
  const moveUnit = (m: Move): CompactProgress => {
    if (!replayable) {
      abortMove("unjournaled");
      return "none";
    }

    const into = m.into;
    try {
      switch (m.phase) {
        case "load":
          if (!into.domainLoad(m.saved.state)) {
            moveRefused = true;
            abortMove("refused");
            return "none";
          }

          m.abcs = m.saved.abcs.entries();
          m.phase = "abcs";
          return "moving";
        case "abcs": {
          const next = m.abcs?.next();
          if (next && !next.done) {
            if (into.domainLoadAbc(next.value[0], next.value[1]) !== 0) {
              abortMove("refused");
              return "none";
            }

            return "moving";
          }

          m.abcs = null;
          if (!into.domainLoadRebuild()) {
            abortMove("refused");
            return "none";
          }

          m.phase = "rebuild";
          return "moving";
        }
        case "rebuild": {
          const step = into.domainRebuildStep();
          if (step < 0) {
            abortMove("refused");
            return "none";
          }

          if (step > 0) {
            m.phase = "catch up";
          }

          return "moving";
        }
        case "catch up": {
          // Entries of domains dropped since are out of the journal (see
          // forgetDropped), but one half replayed is finished.
          while (
            m.word === 0 &&
            m.replayed < m.entries.length &&
            !journal.has(m.entries[m.replayed])
          ) {
            m.replayed++;
          }

          if (m.replayed === m.entries.length) {
            swapMove(m);
            return "done";
          }

          // A compile's log a log entry a part, a run of them taking long.
          const entry = m.entries[m.replayed];
          if (entry.kind === "log") {
            const w = entry.words;
            const i = m.word;
            if (!into.replayEntry(w[i], w[i + 1], w[i + 2], w[i + 3])) {
              abortMove("refused");
              return "none";
            }

            m.word = i + 4 < w.length ? i + 4 : 0;
            if (m.word === 0) {
              m.replayed++;
            }

            return "moving";
          }

          m.replayed++;
          // A revival that rebuilds the spare: catch-up starts over after it.
          if (replayOne(into, entry, true)) {
            m.phase = "rebuild";
            m.catchUp = 0;
          }

          return "moving";
        }
      }
    } catch (error) {
      abortMove(
        error instanceof CodegenPanic || error instanceof CodegenOutOfMemory ? "spare" : "refused",
      );
      return "none";
    }
  };
  // Whether the move's next part replays a call that takes long in one:
  // a compile's verification of a large ABC, as long as the compile
  // verified it for, or the add of a large ABC, which parses and links it.
  const longNext = (m: Move) => {
    const entry = m.phase === "catch up" ? m.entries[m.replayed] : undefined;
    if (entry?.kind === "add") {
      return entry.abc.length > LARGE_Add;
    }

    return (
      entry?.kind === "log" &&
      entry.words[m.word] === LOG_Verify &&
      (abcLengths[entry.words[m.word + 1]] ?? 0) > LARGE_Verify
    );
  };
  // What compactStep starts, as compact decides, but that a large domain
  // moves rather than rebuild in place, which would take one call.
  const beginCompaction = (): CompactProgress => {
    if (spare === null && !making && wasm.domainWantsCompact(WANT_Spare)) {
      prepare();
    }

    const wantsMove = wasm.domainWantsCompact(WANT_Move);
    const beside = spare !== null || making;
    const inPlace =
      !wantsMove && wasm.domainWantsCompact(beside ? WANT_InPlaceBesideSpare : WANT_InPlace);
    if (!wantsMove && !inPlace) {
      return "none";
    }

    if (inPlace && (moveRefused || Number(wasm.domainUsage().split(" ")[0]) < IN_PLACE_Live)) {
      return wasm.domainCompact(true) && rebuild(wasm, null, true) ? "done" : "none";
    }

    // A spare could not catch up from the journal: compacted in one call, as compact does.
    if (!replayable) {
      return api.compact() ? "done" : "none";
    }

    // Backed off after a move that failed.
    if (lettings < retryAt) {
      return "none";
    }

    const into = spare;
    if (into === null) {
      // Called again once the spare is made, as instantiating is asynchronous.
      prepare();
      return making ? "moving" : "none";
    }

    spare = null;
    return startMove(into) ? "moving" : "none";
  };
  // Whether the domain was lost to a panic recovery could not undo (see fresh).
  let lost = false;
  const api: Codegen = {
    identity,
    abcVersion(abc) {
      const packed = wasm.abcVersion(abc);
      return packed < 0 ? null : { major: packed >>> 16, minor: packed & 0xffff };
    },
    get epoch() {
      return epoch;
    },
    reset(version = API_VERSION) {
      checkApiVersion(version);
      abortMove("superseded");
      moveRefused = false;
      retryAt = 0;
      wasm.domainReset(version);
      added = 0;
      epoch++;
      revisionEpoch++;
      journalDomains.clear();
      chains.clear();
      apiVersion = version;
      journal.clear();
      restores.clear();
      abcDomains.length = 0;
      abcLengths.length = 0;
      replayable = true;
      checkpoint = null;
    },
    get apiVersion() {
      return apiVersion;
    },
    add(abc, builtin = false, appDomain = 0) {
      const bytes = new Uint8Array(abc);
      const error = wasm.domainAdd(bytes, builtin, appDomain);
      if (error < 0) {
        throw new Error(`application domain ${appDomain}: never made, or dropped`);
      }

      if (error === 0 || wasm.lastAddLinked()) {
        if (error === 0) {
          abcDomains.push(appDomain);
          abcLengths.push(bytes.length);
        }
        journaled(
          {
            kind: "add",
            abc: bytes,
            builtin,
            appDomain,
            index: error === 0 ? added : -1,
            error,
          },
          appDomain,
        );
      }
      if (error === 0) {
        added++;
      }

      return error;
    },
    childDomain(parent) {
      const domain = wasm.domainChild(parent);
      if (domain < 0) {
        throw new Error(`application domain ${parent}: never made, or dropped`);
      }

      const owner = journalDomains.get(parent | 0);
      const child = { id: domain, parent: owner };
      if (owner) {
        owner.children ??= new Set();
        owner.children.add(child);
      }

      journalDomains.set(domain, child);
      journaled({ kind: "child", parent });

      return domain;
    },
    dropDomain(appDomain, of = epoch) {
      if (of === epoch) {
        lettings++;
        wasm.domainDrop(appDomain);
        journaled({ kind: "drop", appDomain });
        forgetDropped(appDomain);

        chains.forget((d) => wasm.domainState(d) === 2);
      }
    },
    evictDomain(appDomain) {
      lettings++;
      wasm.domainEvict(appDomain);
      journaled({ kind: "evict", appDomain });
    },
    usage() {
      const [live, dead, memory] = wasm.domainUsage().split(" ").map(Number);
      return {
        live,
        dead,
        memory,
        failedMoves,
        moves: { ...moves, aborted: { ...moves.aborted } },
        recovery: recoveryBytes(),
      };
    },
    memoryBytes() {
      return wasm.memory.buffer.byteLength;
    },
    compact() {
      // A move compactStep has under way, finished here.
      const m = move;
      if (m !== null) {
        let progress = moveUnit(m);
        while (progress === "moving") {
          progress = moveUnit(m);
        }

        if (progress === "done") {
          return true;
        }
      }

      // Done in the spare instance, once there is one and that would take
      // less memory, or in place would not fit; else in place, where the
      // new tables are made while the old are live, only where they fit
      // and, beside a spare made or being made, a move would not do better.
      if (spare === null && !making && wasm.domainWantsCompact(WANT_Spare)) {
        prepare();
      }

      if (spare !== null && wasm.domainWantsCompact(WANT_Move)) {
        if (moved()) {
          return true;
        }
      }

      const beside = spare !== null || making;
      if (!wasm.domainWantsCompact(beside ? WANT_InPlaceBesideSpare : WANT_InPlace)) {
        return false;
      }

      return wasm.domainCompact(true) && rebuild(wasm, null, true);
    },
    compactStep(deadline) {
      let m = move;
      if (m === null) {
        const begun = beginCompaction();
        if (begun !== "moving" || move === null) {
          return begun;
        }

        m = move;
      }

      // Catch-up chases what the host goes on doing. Past CATCH_UP_Slices
      // slices it goes on CATCH_UP_Overrun past the deadline, a long part
      // still starting a slice of its own; past twice as many, it finishes
      // in this slice, which has only what came in since the last to
      // replay (a revival's rebuild still a part at a time).
      let slices = 0;
      if (m.phase === "catch up") {
        slices = ++m.catchUp;
      }

      for (;;) {
        const progress = moveUnit(m);
        if (progress !== "moving") {
          return progress;
        }

        const catchingUp = m.phase === "catch up";
        if (catchingUp && slices > CATCH_UP_Slices * 2) {
          continue;
        }

        // A part that takes long in one call starts a slice of its own,
        // so that it adds to no other part's time.
        if (longNext(m)) {
          return "moving";
        }

        const overrun = catchingUp && slices > CATCH_UP_Slices ? CATCH_UP_Overrun : 0;
        if (deadline.timeRemaining() <= -overrun) {
          return "moving";
        }
      }
    },
    isLive(appDomain) {
      return wasm.domainState(appDomain) === 0;
    },
    reviveDomain(appDomain, abcs) {
      // A move's spare lets go of the ABCs of the domains evicted before its
      // snapshot, and before any rebuild a replayed revival makes in it,
      // which this instance may still hold: restores journaled before the
      // revival give each evicted ABC back to it (see replayOne).
      const evictedGiven =
        move === null
          ? []
          : [...abcs.keys()].filter(
              (index) =>
                Number.isInteger(index) &&
                index >= 0 &&
                index < abcDomains.length &&
                wasm.domainState(abcDomains[index]) === 1,
            );
      // Its ABCs' bytes are copied into the compiler only if a rebuild let go of them.
      let revived = wasm.domainRevive(appDomain, true);
      if (revived < 0) {
        for (const [index, bytes] of abcs) {
          const owned = new Uint8Array(bytes);
          const error = wasm.domainRestore(index, owned);
          if (error !== 0) {
            throw new Error(`ABC ${index}: not of an evicted domain, or rejected (${error})`);
          }
          // One restore an ABC, the first: a revival retried gives its
          // bytes again, which the compiler, holding them, does not take.
          if (!restores.has(index)) {
            const entry: Entry = { kind: "restore", index, bytes: owned };
            restores.set(index, entry);
            journaled(entry, abcDomains[index]);
          }
        }

        revived = wasm.domainRevive(appDomain, true);
      }

      // Revived by a rebuild in place, mid-load: a compaction moves it later.
      const done = revived === 0 || (revived > 0 && rebuild());
      if (revived === 0) {
        // Owned by the root, not by the domain: a revival the journal keeps
        // needs them though the domain is dropped later (a drop forgets the
        // domain's own entries, see forgetDropped), until the next checkpoint.
        if (move !== null) {
          for (const index of evictedGiven) {
            const given = abcs.get(index);
            if (given !== undefined) {
              let bytes = move.restored.get(index);
              if (bytes === undefined) {
                bytes = new Uint8Array(given);
                move.restored.set(index, bytes);
              }

              journaled({ kind: "restore", index, bytes });
            }
          }
        }

        journaled({ kind: "revive", appDomain });
      }

      if (!done) {
        throw new Error(
          `application domain ${appDomain}: not evicted, its parent not live, or an ABC of it not given`,
        );
      }
    },
    found({ domain, nsKind, uri, name, abc, asType }) {
      wasm.domainFound(domain, nsKind, uri, name, abc, asType);
      // A finding of an ABC outside the finder's chain, which the player
      // never reports, is not journaled: its replay can part from the
      // compile (the compiler takes it unchecked).
      if (inChain(abcDomains[abc] ?? -1, domain)) {
        journaled(
          { kind: "found", definition: { domain, nsKind, uri, name, abc, asType } },
          domain,
        );
      } else if (move !== null && wasm.domainState(domain) >= 0 && wasm.domainState(domain) < 2) {
        // The spare could part from this instance by it; one of a domain
        // dropped or never made the compiler ignored.
        abortMove("unjournaled");
      }
    },
    compile(hashes = [], index = -1) {
      last("compile");
      // Each part a call of its own, whose arena the next gives back: the
      // module's garbage is gone before its entries are written.
      const module = compiled(hashes, index, true);
      const sourceMap = wasm.domainSourceMap();
      const entries = parseEntries(wasm.domainModuleEntries());
      return { module, sourceMap, entries };
    },
    compileModule(hashes = [], index = -1) {
      last("compileModule");
      return compiled(hashes, index, false);
    },
    context(index = -1, after = 0, upTo = -1) {
      // A domain lost to a panic has no context until the next reset.
      if (added === 0 || lost) {
        return null;
      }

      const text = wasm.domainContext(indexOf(index), after, upTo);
      if (text === "") {
        return null;
      }

      const first = text.indexOf("\n");
      const second = text.indexOf("\n", first + 1);
      const abcs = text.slice(0, first);
      return {
        abcs: abcs ? abcs.split(",").map(Number) : [],
        own: Number(text.slice(first + 1, second < 0 ? text.length : second)),
        log: second < 0 ? "" : text.slice(second + 1),
      };
    },
    keyContext(index = -1, after = 0) {
      if (added === 0) {
        return null;
      }

      return chains.context(indexOf(index), after);
    },
    revision() {
      return `${revisionEpoch} ${wasm.domainRevision()}`;
    },
    compileModuleLogged(hashes = [], index = -1) {
      last("compileModuleLogged");
      const mark = wasm.domainLogMark();
      const module = compiled(hashes, index, false);
      const log = wasm.domainLogSince(mark, indexOf(index));
      return { module, log: log === "!" ? null : log };
    },
    replay(log, index = -1) {
      last("replay");
      const replay = () => wasm.domainReplay(log, indexOf(index));
      return recordChanges(replay);
    },
    compileActions(bytes, actions) {
      const module = actionsModule(bytes, actions, true);
      const entries = parseEntries(wasm.actionsModuleEntries());
      const units = new Map<string, ModuleUnit>();
      for (const item of wasm.actionsModuleUnits().split("\u0002")) {
        const [key, numbers, limits, code] = item.split("\u0001");
        if (code !== undefined) {
          const [at, end, bound, five] = numbers.split(",").map(Number);
          const [high, reach] = limits.split(",").map(Number);
          units.set(key, { code, high, reach, unit: { at, end, bound, five: five !== 0 } });
        }
      }

      return { module, entries: actions.blocks.map((_, k) => entries.get(k) ?? ""), units };
    },
    compileActionsModule(bytes, actions) {
      return actionsModule(bytes, actions, false);
    },
    compileActionBlocks(bytes, actions, blocks) {
      const indices = blocks.filter((b) => Number.isInteger(b) && b >= 0);
      if (indices.length === 0) {
        return new Map();
      }

      // The SWF held, as for units: a block needs it whole, and copying it
      // in for each block cost a copy of the SWF in codegen's memory
      // beside the one held for units, and the time to copy it.
      const handle = hold(bytes, actions);
      const address = wasm.actionsHeldEmitEachBytes(handle, actions.version, indices.join(","));
      const text = handed(address, wasm.outputLength());
      // A block's analysis can go before the next block runs.
      return parseEntries(text);
    },
    compileActionUnit(bytes, actions, { at, end, bound, five }) {
      const handle = hold(bytes, actions);
      const address = wasm.actionsHeldUnitBytes(handle, actions.version, at, end, bound, five);
      const code = handed(address, wasm.outputLength());
      const [high, reach] = wasm.actionsUnitLimits();
      return { code, high, reach };
    },
    releaseActions(bytes) {
      const known = holding.get(bytes);
      if (known !== undefined) {
        release(known.handle);
        holding.delete(bytes);
        collectedSwfs.unregister(known);
      }
    },
    heldActions() {
      return { held: wasm.actionsHeldCount(), copies };
    },
  };
  // Each method recovers from a panic of the compiler (see recover): an
  // ABC whose load panicked is rejected as a corrupt one is, and any other
  // call that panicked throws a plain Error, the compiler going on. Where
  // recovery cannot be, the domain is lost, but not the compiler: it goes
  // on in a fresh instance, for a reset and what needs no domain (AVM1),
  // and the domain's calls throw until the next reset.
  const fresh = () => {
    abortMove("superseded");
    wasm = spare ?? recoveryInstance(module);
    spare = null;
    holds.length = 0;
    chains.clear();
  };
  const descriptors = Object.getOwnPropertyDescriptors(api);
  for (const [name, descriptor] of Object.entries(descriptors)) {
    const method = descriptor.value;
    if (typeof method !== "function") {
      continue;
    }

    const domainless = DOMAINLESS.has(name);
    descriptor.value = (...args: unknown[]) => {
      // An instance left dead outside a call of this wrapper (a finalizer's
      // release) is recovered from first, or given way to.
      if ((wasm as { panicked?: () => string | null }).panicked?.() != null && !recover()) {
        fresh();
        lost = true;
      }

      // The player drops a domain from a FinalizationRegistry's callback,
      // and compacts from a timer, where a throw would go nowhere: a lost
      // domain has nothing to drop, nor to compact.
      if (lost && name === "dropDomain") {
        return undefined;
      }

      if (lost && name === "compact") {
        return false;
      }

      if (lost && name === "compactStep") {
        return "none";
      }

      if (lost && !domainless) {
        throw new Error(
          `${name}: the compiler's domain was lost to a panic it could not recover from; reset it`,
        );
      }

      try {
        const result = method.apply(api, args);
        if (name === "reset") {
          lost = false;
        }

        return result;
      } catch (error) {
        if (!(error instanceof CodegenPanic)) {
          throw error;
        }

        if (!recover()) {
          // A reset that panicked too: what the wrapper keeps of the domain
          // (its ABCs, journal, checkpoint and API version) is the dead one's.
          fresh();
          lost = true;
          throw new Error(
            `${name}: ${error.message}; the compiler went on in a new instance, its domain lost`,
          );
        }

        if (name === "add") {
          return PANICKED_ABC;
        }

        throw new Error(`${name}: ${error.message}; the compiler went on in a new instance`);
      }
    };
  }

  return Object.defineProperties({}, descriptors) as Codegen;
}

/** An instance of the compiler, its exports bound. */
type Bound = CodegenExports & { panicked(): string | null };

/** What a lost domain does not stop (see lost): a reset, AVM1, and what reads no domain. */
const DOMAINLESS = new Set([
  "reset",
  "abcVersion",
  "compileActions",
  "compileActionsModule",
  "compileActionBlocks",
  "compileActionUnit",
  "releaseActions",
  "heldActions",
  "memoryBytes",
  "usage",
  "context",
]);

/** An ABC with nothing in it, which a dropped domain's ABCs give way to in the journal of calls. */
const EMPTY_ABC = Uint8Array.of(16, 0, 46, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

/** The VerifyError an ABC whose load panicked Zig's compiler is rejected with: kCorruptABCError. */
const PANICKED_ABC = 1107;

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

/** What domainWantsCompact is asked: lifetime.zig's Want, by number (a unit test holds them alike). */
const WANT_InPlace = 0;
const WANT_InPlaceBesideSpare = 1;
const WANT_Move = 2;
const WANT_Spare = 3;
/**
 * The live weight (domainUsage's first number) below which compactStep
 * rebuilds in place, in one call, rather than move a part at a time.
 */
const IN_PLACE_Live = 4 << 20;
/** A compile's log entry that verified an ABC: LogKind.verify (avm2/link/domain.zig). */
const LOG_Verify = 4;
/**
 * The length of an ABC whose verification, replayed, starts a slice of its
 * own: some 20 ms of it on real content, 750 ms for 2.3 MB.
 */
const LARGE_Verify = 64 << 10;
/** The garbage a part of a move's rebuild makes at most (domainRebuildBudget). */
const MOVE_PartBudget = 256 << 10;
/** The slices compactStep catches a move up in before it goes on past their deadlines (see compactStep). */
const CATCH_UP_Slices = 32;
/** How far past its deadline a slice catches up after CATCH_UP_Slices, in milliseconds. */
const CATCH_UP_Overrun = 50;
/** The length of an ABC whose add, replayed, starts a slice of its own: some 4 ms of parsing and linking. */
const LARGE_Add = 256 << 10;
/** The drops and evictions after a move given up as failed before compactStep starts another. */
const RETRY_Lettings = 16;
/** How many SWFs whose blocks or units are compiled codegen holds a copy of at most. */
const HELD_SWFS = 4;

// TextDecoder is the web's and node's alike, though not ECMAScript's,
// whose library alone the compiler's wrapper is typed against.
declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };

const utf8 = new TextDecoder();
