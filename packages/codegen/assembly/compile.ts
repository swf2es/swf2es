// The compiler as codegen.wasm exports it, and as the test build does too,
// so that the two builds run the same code: a domain the ABCs are added
// to, and the module, the source map and the method entries the last one
// compiles to, whole, as the JIT and ahead-of-time compilation take them,
// and, for the test build, a method at a time, each as it is in the module
// (see docs/architecture/compiler.md).
import { bodyDecoder, releaseDecoder, verifyMethods } from "./avm2/abc/code";
import * as C from "./avm2/abc/constants";
import { PADDING } from "./avm2/abc/reader";
import { ModuleEmitter } from "./avm2/emit/module";
import {
  DOMAIN_Live,
  Domain,
  LOG_Found,
  LOG_None,
  LOG_Resolve,
  LOG_Sign,
  LOG_Verify,
} from "./avm2/link/domain";
import {
  addWeights,
  drop,
  evict,
  evictedTop,
  Loaded,
  loadAbc,
  loadDomain,
  loadedAll,
  loadedSize,
  MOVE_Limit,
  Rebuild,
  restore,
  revive,
  saveDomain,
  savedBytes,
  savedLive,
  traitsOf,
  unrevive,
  wantsRebuild,
  weigh,
} from "./avm2/link/lifetime";
import { TRAITS_Activation, TRAITS_Instance, TRAITS_Script } from "./avm2/link/traits";
import { handOut, handOutBytes, Output } from "./output";

export let domain = new Domain();

// The last ABC's methods verified, kept for domainEmitEach, which compiles
// them one at a time; another ABC added, or a new domain, starts over.
let verified: StaticArray<i32> | null = null;

/**
 * The emitter of the module domainModule wrote last, if it was kept: its
 * source map and entries are written when asked for, not with the module,
 * whose memory they would add to that call's. A large ABC's entries alone,
 * decoded, doubled codegen's memory, which never shrinks.
 */
let written: ModuleEmitter | null = null;

/**
 * Start a new domain whose user ABCs have API version `apiVersion`, whose
 * series, Flash Player's or AIR's, is the domain's.
 */
export function domainReset(apiVersion: i32): void {
  abandon();
  domain = new Domain();
  domain.apiVersion = <u8>apiVersion;
  verified = null;
  written = null;
  releaseDecoder();
}

/**
 * Add an ABC to the domain, loaded into application domain `appDomain`
 * (0, the root, or one domainChild made); 0, or the VerifyError it was
 * rejected with; -1 for an application domain never made or dropped.
 */
export function domainAdd(bytes: Uint8Array, builtin: bool, appDomain: i32 = 0): i32 {
  abandon();
  if (!isLive(appDomain)) {
    return -1;
  }

  const buffer = new StaticArray<u8>(bytes.length + PADDING);
  memory.copy(changetype<usize>(buffer), bytes.dataStart, bytes.length);
  verified = null;
  return domain.add(buffer, bytes.length, builtin, <u32>appDomain).error;
}

/** A new application domain, a child of `parent`'s: its number, or -1 if `parent` was never made or was dropped. */
export function domainChild(parent: i32): i32 {
  // A rebuild under way shares the domain tree this grows.
  leaveRebuild();
  return isLive(parent) ? <i32>domain.childDomain(<u32>parent) : -1;
}

function isLive(appDomain: i32): bool {
  return (
    appDomain >= 0 &&
    appDomain < domain.domainParent.length &&
    domain.domainState[<u32>appDomain] === DOMAIN_Live
  );
}

/**
 * Drop application domain `appDomain` and its descendants, as the runtime
 * has let go of them: their ABCs are seen by no other and compile no more,
 * and their indices are not given to others. What they took is let go of
 * by domainCompact.
 */
export function domainDrop(appDomain: i32): void {
  abandon();
  if (appDomain >= 0) {
    drop(domain, <u32>appDomain);
  }
}

/**
 * Evict application domain `appDomain` and its descendants while the host
 * has no use for them, as when it has compiled all their ABCs: as dropped,
 * until domainRevive. Once compacted away, a domain evicted takes only its
 * log (see Domain.logKind) and its ABCs' places; the host keeps their
 * bytes to give again.
 */
export function domainEvict(appDomain: i32): void {
  abandon();
  if (appDomain >= 0) {
    evict(domain, <u32>appDomain);
  }
}

/** Application domain `appDomain`'s state: 0 live, 1 evicted, 2 dropped, -1 never made. */
export function domainState(appDomain: i32): i32 {
  return appDomain >= 0 && appDomain < domain.domainState.length
    ? domain.domainState[<u32>appDomain]
    : -1;
}

/**
 * Give ABC `index`, of an evicted application domain, its bytes again, if
 * a rebuild has let go of them, before domainRevive: 0, the VerifyError
 * they were rejected with, or -1 if the ABC is not of an evicted domain.
 */
export function domainRestore(index: i32, bytes: Uint8Array): i32 {
  abandon();
  if (index < 0) {
    return -1;
  }

  const buffer = new StaticArray<u8>(bytes.length + PADDING);
  memory.copy(changetype<usize>(buffer), bytes.dataStart, bytes.length);
  return restore(domain, <u32>index, buffer, bytes.length);
}

/**
 * Make evicted application domain `appDomain` live again, with its evicted
 * ancestors, given again those of their ABCs domainRestore was asked for
 * (after a -1 here): their ABCs link again as they did, and what they
 * found holds, by one rebuild if one has been since any was evicted. 0, 1
 * after a rebuild, which a collection would free, or -1, leaving them
 * evicted, if they cannot be. With `stepped`, 2 in place of a rebuild done
 * here: one started, which domainRebuildStep does a part at a time, and
 * which leaves them evicted if it fails.
 */
export function domainRevive(appDomain: i32, stepped: bool = false): i32 {
  abandon();
  if (appDomain < 0) {
    return -1;
  }

  const bottom = <u32>appDomain;
  const top = bottom < <u32>domain.domainState.length ? evictedTop(domain, bottom) : bottom;
  const revived = revive(domain, bottom);
  if (revived <= 0) {
    return revived;
  }

  if (stepped) {
    start(new Rebuild(domain), rebuildBudget());
    revivedBottom = <i32>bottom;
    revivedTop = top;
    return 2;
  }

  if (!domainRebuild()) {
    unrevive(domain, bottom, top);
    return -1;
  }

  return 1;
}

/**
 * Rebuild the domain without the ABCs of domains not live, once memory
 * would otherwise grow and they hold enough to keep it from growing (see
 * wantsRebuild in avm2/link/lifetime.ts):
 * whether it was, and a collection would free them now. A host calls it
 * when it has time, as when idle, so a batch of drops and evictions costs
 * one rebuild. Later modules come out the same either way. With
 * `stepped`, whether one was started, which domainRebuildStep does a part
 * at a time.
 */
export function domainCompact(stepped: bool = false): bool {
  if (!wantsRebuild(domain, rebuildBudget(), false, false)) {
    return false;
  }

  return domainRebuild(stepped);
}

/**
 * The domain built again from its live ABCs (see Rebuild in avm2/link/lifetime.ts), worth it
 * or not, as the fuzzers ask; false, leaving it, if one did not link. With
 * `stepped`, started, for domainRebuildStep to do a part at a time.
 */
export function domainRebuild(stepped: bool = false): bool {
  abandon();
  const rebuild = new Rebuild(domain);
  if (stepped) {
    start(rebuild, rebuildBudget());
    return true;
  }

  rebuild.step(u64.MAX_VALUE);
  return rebuilt(rebuild.fresh);
}

/**
 * The next part of the rebuild domainCompact or domainRevive started: 0
 * while some is left, the host collecting garbage before it asks for the
 * next, 1 once done, and -1 if it failed, leaving the domain as it was,
 * and a domain being revived evicted, or if none was started. A part makes
 * about the bytes of garbage the rebuild was started with (rebuildBudget),
 * so that memory holds the old tables, if any, and the new and little
 * more: verifying every ABC again in one call took more than the tables.
 * Nothing else may be called in between but __collect: anything that
 * compiles or changes the domain abandons it (see abandon).
 */
export function domainRebuildStep(): i32 {
  const rebuild = rebuilding;
  if (rebuild === null) {
    return -1;
  }

  if (!rebuild.step(rebuildingBudget)) {
    return 0;
  }

  rebuilding = null;
  if (rebuilt(rebuild.fresh)) {
    revivedBottom = -1;
    return 1;
  }

  unreviveRebuilt();
  releaseDecoder();
  return -1;
}

/**
 * The garbage a part of a rebuild makes, roughly: a sixteenth of memory,
 * PART_BUDGET at least, or what a test set. A collection between parts
 * marks every table, old and new, tens of milliseconds for a large
 * application's, so parts of PART_BUDGET took a rebuild from 3.5 to 7
 * seconds; a sixteenth of memory is within the reserve wantsRebuild keeps.
 */
function rebuildBudget(): u64 {
  return partBudget === PART_BUDGET
    ? max<u64>(PART_BUDGET, ((<u64>memory.size()) << 16) >> 4)
    : partBudget;
}

/** Start `rebuild`, for domainRebuildStep to do a part of `budget` bytes of garbage at a time. */
function start(rebuild: Rebuild, budget: u64): void {
  rebuilding = rebuild;
  rebuildingBudget = budget;
}

/**
 * The rebuild a part at a time and the garbage each part may make, and the
 * evicted domains it revives, from `revivedBottom` up to `revivedTop`; -1
 * for none.
 */
let rebuilding: Rebuild | null = null;
let rebuildingBudget: u64 = 0;
let revivedBottom: i32 = -1;
let revivedTop: u32 = 0;

/** Make `fresh`, a rebuild's new Domain, the domain: whether there was one. */
function rebuilt(fresh: Domain | null): bool {
  if (fresh === null) {
    return false;
  }

  // A closure's scope is found by verifying its ABC, which domainEmitEach does
  // once for its first method: the new domain has none found yet.
  domain = fresh;
  verified = null;
  written = null;
  // The decoder may still be made for the old domain, which it would keep.
  releaseDecoder();
  return true;
}

/** Evict again the domains a rebuild that failed or was left was reviving, as revive found them. */
function unreviveRebuilt(): void {
  if (revivedBottom >= 0) {
    unrevive(domain, <u32>revivedBottom, revivedTop);
    revivedBottom = -1;
  }
}

/**
 * What a rebuild reads of the domain but its ABCs' bytes, handed out (see
 * handOut and saveDomain), for another instance to rebuild it in a memory
 * of its own (domainLoad): wasm memory never shrinks, so one rebuilt in
 * place keeps the old tables' room beside the new for good. Leaves
 * nothing, so that a revival started with `stepped` is saved revived.
 */
export function domainSaveBytes(): usize {
  // In domainContext's buffer: one kept for this alone took a library's
  // compile across a doubling of memory.
  saveDomain(domain, context);
  return handOut(context);
}

/** The bytes of live ABC `index`, as added, handed out (see handOut), for domainLoadAbc; none for another. */
export function domainSavedAbcBytes(index: i32): usize {
  if (index < 0 || !savedLive(domain, <u32>index)) {
    return handOut(null);
  }

  return handOutBytes(savedBytes(domain, <u32>index), domain.abcs[index].length);
}

/**
 * In a new instance, start a domain as another's domainSaveBytes saved
 * it: whether the words were that, for domainLoadAbc to give its live
 * ABCs and domainLoadRebuild to rebuild it.
 */
export function domainLoad(words: Uint8Array): bool {
  abandon();
  const loaded = loadDomain(words);
  loading = loaded;
  if (loaded === null) {
    return false;
  }

  // Memory grown at once, by a block let go of at once (see rebuiltSize),
  // and the rebuild's parts held to the garbage that size allowed for.
  loadingBudget = rebuildBudget();
  const size = loadedSize(loaded, loadingBudget);
  if (size >= MOVE_Limit) {
    loading = null;
    return false;
  }

  heap.free(heap.alloc(<usize>size));
  return true;
}

/** Give ABC `index` of the domain domainLoad started its bytes (domainSavedAbcBytes'): 0, -1, or a VerifyError (see loadAbc). */
export function domainLoadAbc(index: i32, bytes: Uint8Array): i32 {
  const into = loading;
  if (into === null || index < 0) {
    return -1;
  }

  const buffer = new StaticArray<u8>(bytes.length + PADDING);
  memory.copy(changetype<usize>(buffer), bytes.dataStart, bytes.length);
  return loadAbc(into, <u32>index, buffer, bytes.length);
}

/**
 * Start rebuilding the domain domainLoad started, given all its live ABCs,
 * as the domain this instance compiles once domainRebuildStep is done:
 * whether it was started.
 */
export function domainLoadRebuild(): bool {
  const into = loading;
  if (into === null || !loadedAll(into)) {
    return false;
  }

  abandon();
  loading = null;
  verified = null;
  written = null;
  start(new Rebuild(into.dom), loadingBudget);
  return true;
}

/** The domain domainLoad started, until domainLoadRebuild, and the garbage its parts may make. */
let loading: Loaded | null = null;
let loadingBudget: u64 = 0;

/**
 * Record what application domain `appDomain` has found by a name, in the
 * namespace of kind `nsKind` and URI `uri`, as the runtime reports it where
 * it is not the first definition from the root down: the definition ABC
 * `abc` gives the name, its script's binding by name, or its class as a
 * type (`asType`). What the domain's later ABCs compile against.
 */
export function domainFound(
  appDomain: i32,
  nsKind: i32,
  uri: string,
  name: string,
  abc: i32,
  asType: bool,
): void {
  abandon();
  verified = null;
  domain.addFound(<u32>appDomain, <u8>nsKind, uri, name, <u32>abc, asType);
}

/** Each body of ABC `index`'s VerifyError, 0 if it verified, -1 if nothing runs it; verified once per ABC asked for. */
function verifiedBodies(index: u32): StaticArray<i32> {
  let results = verified;
  if (results === null || verifiedIndex !== index) {
    results = verifyMethods(domain, index);
    verified = results;
    verifiedIndex = index;
  }

  return results;
}

let verifiedIndex: u32 = 0;

/**
 * ABC `index` of the domain, or the last added for -1; -1 again where
 * there is none, or its application domain is not live.
 */
function abcIndex(index: i32): i32 {
  if (domain.abcs.length === 0 || index >= domain.abcs.length) {
    return -1;
  }

  const at = index < 0 ? domain.abcs.length - 1 : index;
  return domain.isLive(<u32>at) ? at : -1;
}

/**
 * The ES module ABC `index` compiles to, the last added for -1, against
 * every ABC the domain holds, those added after it included: a SWF's
 * DoABCs are all added before any compiles, as avmplus has every ABC of a
 * frame loaded before it verifies a method. `hashes` are the ABCs' hashes
 * in load order, one per line, as the cache key names them; with
 * `linkedOnly`, its own and then those domainLinked names.
 */
export function domainModule(
  hashes: string = "",
  index: i32 = -1,
  keep: bool = true,
  linkedOnly: bool = false,
): string {
  const out = writeModule(hashes, index, keep, linkedOnly);
  return out === null ? "" : String.UTF8.decodeUnsafe(changetype<usize>(out.bytes), out.length);
}

/**
 * domainModule's module as its UTF-8 bytes, which the host decodes: a
 * module of megabytes is decoded there many times faster than made a
 * string here and lifted a code unit at a time. Handed out where they are
 * (handOut), none where it is "". Only its first part, if domainModuleDone
 * is then false: domainModuleMoreBytes hands out each next, a call each,
 * so that the host collects each part's garbage before the next, and
 * codegen's memory, which never shrinks, need hold no more than a part
 * (see ModuleEmitter.begin). Nothing else may be called in between but
 * __collect: anything else that compiles or changes the domain abandons
 * the module (see abandon). The wrapper asks for every part before it
 * calls anything else, so it never abandons one.
 */
export function domainModuleBytes(
  hashes: string = "",
  index: i32 = -1,
  keep: bool = true,
  linkedOnly: bool = false,
): usize {
  const emitter = startModule(hashes, index, keep, linkedOnly);
  if (emitter === null) {
    return handOut(null);
  }

  stepModule(emitter, false);
  return handOut(emitter.out);
}

/** The next part of the module domainModuleBytes started, handed out as it hands out the first; none once it is done. */
export function domainModuleMoreBytes(): usize {
  const emitter = pending;
  if (emitter === null) {
    return handOut(null);
  }

  // A module kept keeps all its text, for its source map and entries.
  const from = pendingKeep ? emitter.out.length : 0;
  stepModule(emitter, !pendingKeep);
  return handOut(emitter.out, from);
}

/** Whether the module domainModuleBytes started is done: no part of it is left to hand out, or it was abandoned. */
export function domainModuleDone(): bool {
  return pending === null;
}

/**
 * The bytes of garbage, roughly, a part of a module makes (see
 * ModuleEmitter.step). A collection between parts takes about half a
 * millisecond with a large application's tables live, so smaller parts
 * cost time: at 2 MiB as3pb and the LZ4 program compiled 3 to 4% slower
 * than whole, and a new instance's memory after compiling the player's
 * libraries alone was 8 MiB where whole it was 32; at 4 MiB it was 16,
 * and at 1 MiB no less than at 2.
 */
const PART_BUDGET: u64 = 2 << 20;

let partBudget = PART_BUDGET;

/** For tests: each part's budget, as step counts it; PART_BUDGET for 0 or less. Not in codegen.wasm. */
export function domainPartBudget(bytes: i32): void {
  partBudget = bytes > 0 ? <u64>bytes : PART_BUDGET;
}

/** The module being written a part at a time, what it was started with, and the domain's rows before it. */
let pending: ModuleEmitter | null = null;
let pendingIndex: u32 = 0;
let pendingKeep: bool = false;
let pendingRows: u64 = 0;

/**
 * Leave the module being written a part at a time, as the domain changes
 * under it; its rows are weighed to its ABC as a finished module's are.
 * What it fixed in the domain stays: abandoned while verifying, the ABC
 * stays counted as verified, and the log keeps its LOG_Verify and what the
 * verification resolved so far (see Verifier). A later compile of the ABC
 * then logs a verification of its own after those and resolves the rest
 * after it, so the log, and with it domainContext and any cache key taken
 * from it, is not the one a compile never abandoned leaves. Rolling back
 * cannot fix that: what was resolved is in the domain's tables, and logged
 * again after a new LOG_Verify it would be in another order.
 */
function abandon(): void {
  if (pending !== null) {
    weigh(domain, pendingIndex, pendingRows);
    pending = null;
  }

  leaveRebuild();
}

/**
 * Leave the rebuild under way, which changed nothing of the domain but
 * what it revives; the decoder may be made for its new one.
 */
function leaveRebuild(): void {
  if (rebuilding !== null) {
    rebuilding = null;
    unreviveRebuilt();
    releaseDecoder();
  }
}

function startModule(
  hashes: string,
  index: i32,
  keep: bool,
  linkedOnly: bool,
): ModuleEmitter | null {
  written = null;
  abandon();
  // No ABC, no module: the caller asked before adding one.
  const at = abcIndex(index);
  if (at < 0) {
    return null;
  }

  const emitter = new ModuleEmitter(domain, <u32>at);
  pending = emitter;
  pendingIndex = <u32>at;
  pendingKeep = keep;
  pendingRows = domain.rows();
  emitter.begin(hashes.length ? hashes.split("\n") : [], linkedOnly);
  return emitter;
}

function stepModule(emitter: ModuleEmitter, fresh: bool): void {
  if (!emitter.step(partBudget, fresh)) {
    return;
  }

  pending = null;
  weigh(domain, pendingIndex, pendingRows);
  if (pendingKeep) {
    written = emitter;
  }
}

function writeModule(hashes: string, index: i32, keep: bool, linkedOnly: bool): Output | null {
  written = null;
  abandon();
  // No ABC, no module: the caller asked before adding one.
  const at = abcIndex(index);
  if (at < 0) {
    return null;
  }

  const rows = domain.rows();
  const emitter = new ModuleEmitter(domain, <u32>at);
  emitter.module(hashes.length ? hashes.split("\n") : [], linkedOnly);
  weigh(domain, <u32>at, rows);
  if (keep) {
    written = emitter;
  }

  return emitter.out;
}

/**
 * The indices of the ABCs that ABC `index` (the last added for -1) names as
 * linked, comma-separated in load order: those before it its domain sees,
 * whose hashes domainModule takes after its own with `linkedOnly`, so that
 * a host need not join every ABC's hash for each module it compiles.
 */
export function domainLinked(index: i32 = -1): string {
  const at = abcIndex(index);
  if (at < 0) {
    return "";
  }

  const own = domain.abcDomain[at];
  const out: string[] = [];
  for (let i = 0; i < at; i++) {
    if (domain.sees(own, domain.abcDomain[i])) {
      out.push(i.toString());
    }
  }

  return out.join(",");
}

/** The source map of the module domainModule wrote last, as JSON: its code's AS3 lines, from debugline. */
export function domainSourceMap(): string {
  const emitter = written;
  if (emitter === null) {
    return "";
  }

  const map = new Output();
  emitter.sourceMap(map);
  return String.UTF8.decodeUnsafe(changetype<usize>(map.bytes), map.length);
}

/**
 * Method bodies of ABC `which` (the last added for -1) compiled alone, for
 * the tests that hold each to its entry in F, as the module writes it. `bodies` are
 * their indices, comma-separated, in the order to compile them; `reuse`
 * compiles them all with one emitter, else each with a new one. The ABC is
 * verified once first, which a closure's scope needs. Written as
 * domainModuleEntries writes them, leaving out a native or an unverified.
 */
export function domainEmitEach(bodies: string, reuse: bool, which: i32 = -1): string {
  const entries = emitEach(bodies, reuse, which);
  return String.UTF8.decodeUnsafe(changetype<usize>(entries.bytes), entries.length);
}

/** Entries as UTF-8, handed out where they are (handOut), avoiding AssemblyScript string lifting. */
export function domainEmitEachBytes(bodies: string, reuse: bool, which: i32 = -1): usize {
  return handOut(emitEach(bodies, reuse, which));
}

function emitEach(bodies: string, reuse: bool, which: i32): Output {
  abandon();
  const at = abcIndex(which);
  if (at < 0) {
    return new Output();
  }

  const index = <u32>at;
  const abc = domain.abcs[index];
  const rows = domain.rows();
  const results = verifiedBodies(index);
  const decoder = bodyDecoder(domain, index);
  const entries = new Output();
  let emitter = new ModuleEmitter(domain, index);
  const list = bodies.split(",");
  for (let k = 0; k < list.length; k++) {
    // An empty item, or an index the ABC has no body for, names nothing.
    if (list[k].length === 0) {
      continue;
    }

    const body = <u32>i32.parse(list[k]);
    if (body >= abc.bodyCount) {
      continue;
    }

    const method = abc.bodyMethod[body];
    if (results[body] !== 0 || abc.methodFlags[method] & C.METHOD_Native) {
      continue;
    }

    if (!reuse) {
      emitter = new ModuleEmitter(domain, index);
    }

    const global = domain.methodStart[index] + method;
    decoder.decode(body, domain.traits.scopeOf(global));
    const out = emitter.out;
    out.reset();
    emitter.methods.map.reset();
    emitter.factory(method, global, decoder);
    entries.uint(body);
    entries.byte(1);
    entries.reserve(out.length);
    memory.copy(
      changetype<usize>(entries.bytes) + entries.length,
      changetype<usize>(out.bytes),
      out.length,
    );
    entries.length += out.length;
    entries.byte(2);
  }

  weigh(domain, index, rows);
  return entries;
}

/**
 * Whether domainCompact would rebuild now, the host holding a `spare`
 * instance or not, or, with `elsewhere`, whether a rebuild in another
 * instance (domainSaveBytes) is worth it: memory would
 * grow before long and the ABCs of dropped and evicted domains hold
 * enough to keep it from growing, or, elsewhere, memory is far above what
 * the live ones need (see wantsRebuild in avm2/link/lifetime.ts). A pure
 * query, so that a host collects garbage before a rebuild only when one
 * is due.
 */
export function domainWantsCompact(elsewhere: bool = false, spare: bool = false): bool {
  return wantsRebuild(domain, rebuildBudget(), elsewhere, spare);
}

/**
 * What the domain's ABCs hold of codegen's memory, roughly, and its size,
 * in bytes, "live dead memory": the live ABCs' weight, with the log kept
 * for evicted domains, that of the ABCs of
 * dropped and evicted domains still in the tables, which domainCompact
 * frees, and wasm memory's size. A pure query, for a host deciding when
 * to give domainCompact time.
 */
export function domainUsage(): string {
  addWeights(domain);
  const live = domain.liveWeight + domain.keptWeight;
  return `${live} ${domain.deadWeight} ${(<u64>memory.size()) << 16}`;
}

/**
 * The compiled methods' entries in F of the module domainModule wrote last:
 * for each, its body's index, U+0001, its entry, U+0002.
 */
export function domainModuleEntries(): string {
  const emitter = written;
  if (emitter === null) {
    return "";
  }

  // The entries' bytes copied into one buffer, decoded once.
  const out = emitter.out;
  const entries = new Output();
  for (let k = 0; k < emitter.entryBody.length; k++) {
    const start = emitter.entryStart[k];
    const length = emitter.entryEnd[k] - start;
    entries.uint(emitter.entryBody[k]);
    entries.byte(1);
    entries.reserve(length);
    memory.copy(
      changetype<usize>(entries.bytes) + entries.length,
      changetype<usize>(out.bytes) + start,
      length,
    );
    entries.length += length;
    entries.byte(2);
  }

  return String.UTF8.decodeUnsafe(changetype<usize>(entries.bytes), entries.length);
}

/**
 * What ABC `index`'s module depends on in the domain beyond the ABCs'
 * bytes, for a host's cache key; "" if there is no such ABC. Its first
 * line is the ABCs its application domain sees, by index in load order,
 * those added after it included; the second its place among them; then,
 * in the order they happened, the log's entries about them (see
 * Domain.logKind), each with how many of them there were then: the first
 * answers of what resolves lazily, which see the ABCs there are when they
 * are first asked for, and what the domain and its ancestors were told
 * they found. ABCs are named by their place in the first line, so that
 * the same ABCs loaded at other indices give the same context. Only the
 * entries made with more than `after` ABCs added, and with `upTo` at most
 * where it is not negative: the entries made while the first ABCs were
 * all there were, the libraries', a host keys once for every module.
 */
export function domainContext(index: i32 = -1, after: i32 = 0, upTo: i32 = -1): string {
  const at = abcIndex(index);
  if (at < 0) {
    return "";
  }

  // Written into a buffer kept from call to call: a large application's
  // log took codegen's memory from 32 to 64 MiB as strings joined.
  const own = domain.abcDomain[at];
  const seen = seenBy(own);
  const out = context;
  out.reset();
  writeSeen(out, seen, <u32>at);
  let count: u32 = 0;
  for (let e = 0; e < domain.logKind.length; e++) {
    // Visible ABCs added before the entry happened.
    while (count < <u32>seen.length && seen[count] < domain.logAt[e]) {
      count++;
    }

    const made = <i64>domain.logAt[e];
    if (made <= <i64>after || (upTo >= 0 && made > <i64>upTo)) {
      continue;
    }

    writeEntry(out, e, own, seen, count);
  }

  return String.UTF8.decodeUnsafe(changetype<usize>(out.bytes), out.length);
}

/** The first two lines of a context: the ABCs `seen`, comma-separated, and the place of ABC `at` among them. */
function writeSeen(out: Output, seen: u32[], at: u32): void {
  for (let i = 0; i < seen.length; i++) {
    if (i > 0) {
      out.byte(0x2c);
    }

    out.uint(seen[i]);
  }

  out.byte(0x0a);
  out.uint(placeOf(seen, at));
}

/**
 * Log entry `e` as a context names it to application domain `own`, which
 * sees the ABCs `seen`, `count` of them added before it: a line break,
 * then its kind, its ABC's place in `seen`, `count`, and its numbers, or
 * for a finding how many parents up from `own` the domain that found it
 * is and what it found. Nothing if `own` does not see the entry. Whether
 * it wrote it.
 */
function writeEntry(out: Output, e: i32, own: u32, seen: u32[], count: u32): bool {
  const kind = domain.logKind[e];
  const place = placeOf(seen, domain.logAbc[e]);
  if (kind === LOG_None || place < 0) {
    return false;
  }

  const f = domain.logA[e];
  const depth = kind === LOG_Found ? depthOf(own, domain.foundDomain[f]) : 0;
  if (depth < 0) {
    return false;
  }

  out.byte(0x0a);
  out.uint(kind);
  out.byte(0x20);
  out.uint(place);
  out.byte(0x20);
  out.uint(count);
  out.byte(0x20);
  if (kind !== LOG_Found) {
    out.uint(f);
    out.byte(0x20);
    out.uint(domain.logB[e]);
    return true;
  }

  const uri = domain.foundUri[f];
  const name = domain.foundName[f];
  out.uint(depth);
  out.byte(0x20);
  out.uint(domain.foundKind[f]);
  out.byte(0x20);
  out.uint(domain.foundAsType[f]);
  out.byte(0x20);
  named(out, uri);
  named(out, name);
  return true;
}

/**
 * What a module cache key names of ABC `index` besides its application
 * domain's log, which domainKeyLogBytes gives, handed out (see handOut):
 * the first two lines of domainContext, then the ABC's application
 * domain, how many rebuilds the domain is from its reset, and the index
 * of the first log entry made after the last ABC the domain sees was
 * added. The entries before it are settled for the domain: none changes
 * while it is live, but in a rebuild, where one made since may (a
 * verification's LOG_Verify may go as it ends, see Verifier, and adding
 * an ABC abandons a verification under way). Which those are depends on
 * what the domain sees alone, not on ABCs added elsewhere. No address if
 * there is no such ABC.
 */
export function domainKeyHeaderBytes(index: i32 = -1): usize {
  const at = abcIndex(index);
  if (at < 0) {
    return handOut(null);
  }

  // abcIndex takes only an ABC of a live domain, which sees it, so `seen`
  // holds it; refused all the same where it does not.
  const own = domain.abcDomain[at];
  const seen = seenBy(own);
  if (seen.length === 0) {
    return handOut(null);
  }

  const out = context;
  out.reset();
  writeSeen(out, seen, <u32>at);
  out.byte(0x0a);
  out.uint(own);
  out.byte(0x0a);
  out.uint(domain.generation);
  out.byte(0x0a);
  out.uint(firstAfter(<i32>seen[seen.length - 1]));
  return handOut(out);
}

/** Application domain `appDomain`'s parent; -1 for the root, or for one never made. */
export function domainParent(appDomain: i32): i32 {
  return appDomain > 0 && appDomain < domain.domainParent.length
    ? domain.domainParent[<u32>appDomain]
    : -1;
}

/**
 * How far live application domain `appDomain`'s log, as domainKeyLogBytes
 * writes it, is its parent's, entry for entry: the index of the first log
 * entry past which they may part, 0 for the root or a domain not live,
 * and never past the first made since the last ABC was added, which may
 * still change. Before its first ABC is added, a domain sees what its
 * parent does, by the same places and counts, but for the findings of
 * the two (one parent further up from it) and its own (which its parent
 * does not see).
 */
export function domainKeyFork(appDomain: i32): i32 {
  if (appDomain <= 0 || !isLive(appDomain)) {
    return 0;
  }

  // Never past the entries made before the last ABC was added, which a
  // verification under way may still take back.
  const own = <u32>appDomain;
  let bound = firstAfter(domain.abcs.length - 1);
  for (let i = 0; i < domain.abcs.length; i++) {
    if (domain.abcDomain[i] === own) {
      bound = firstAfter(i);
      break;
    }
  }

  for (let k = 0; k < domain.foundEntry.length; k++) {
    const e = <i32>domain.foundEntry[k];
    if (e >= bound) {
      break;
    }

    if (depthOf(own, domain.foundDomain[k]) >= 0) {
      bound = e;
      break;
    }
  }

  return bound;
}

/**
 * Live application domain `appDomain`'s log, as domainContext writes it
 * for an ABC of the domain, from entry `from` to entry `to` (the log's
 * end where negative), the entries made with `after` ABCs added or fewer
 * left out, handed out (see handOut): no address if `appDomain` is not
 * live. Where `block` is positive, after every `block` entries it writes,
 * `filled` of the first block written before `from`, a line of "#" and
 * the index of the entry after them; and at the end, a line of "$" and
 * the index it ended at. So that a host keying a domain's modules chains
 * the digests of its blocks of settled entries (domainKeyHeaderBytes)
 * once each, and takes its parent's blocks for its own before
 * domainKeyFork.
 */
export function domainKeyLogBytes(
  appDomain: i32,
  after: i32,
  from: i32,
  to: i32,
  block: i32,
  filled: i32,
): usize {
  if (!isLive(appDomain) || from < 0 || filled < 0 || (block > 0 && filled >= block)) {
    return handOut(null);
  }

  const own = <u32>appDomain;
  const seen = seenBy(own);
  const out = context;
  out.reset();
  const length = domain.logKind.length;
  const end = to < 0 || to > length ? length : to;
  let count: u32 = 0;
  let e = max(from, firstAfter(after));
  for (; e < end; e++) {
    while (count < <u32>seen.length && seen[count] < domain.logAt[e]) {
      count++;
    }

    if (writeEntry(out, e, own, seen, count) && block > 0 && ++filled === block) {
      out.byte(0x0a);
      out.byte(0x23);
      out.uint(e + 1);
      filled = 0;
    }
  }

  out.byte(0x0a);
  out.byte(0x24);
  out.uint(e);
  return handOut(out);
}

/** The index of the first log entry made with more than `after` ABCs added, or the log's length. */
function firstAfter(after: i32): i32 {
  let low = 0;
  let high = domain.logAt.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (<i64>domain.logAt[mid] <= <i64>after) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

/** domainContext's buffer, kept from call to call. */
const context = new Output();

/**
 * `s` as domainContext writes a name: its length, ":", and its code units,
 * a backslash, a control character or one past ASCII escaped, so that a
 * line break in the text is always an entry's (see domainKeyLogBytes).
 */
function named(out: Output, s: string): void {
  out.uint(s.length);
  out.byte(0x3a);
  for (let i = 0; i < s.length; i++) {
    const c = <u32>s.charCodeAt(i);
    if (c >= 0x20 && c < 0x7f && c !== 0x5c) {
      out.byte(<u8>c);
    } else {
      out.unit(c);
    }
  }
}

/**
 * What changes whenever domainContext might: how many ABCs there are, how
 * long the log is, and how many rebuilds the domain is from its reset.
 */
export function domainRevision(): string {
  return `${domain.abcs.length} ${domain.logKind.length} ${domain.generation}`;
}

/** How long the domain's log is, to tell what a compile adds to it (domainLogSince). */
export function domainLogMark(): i32 {
  return domain.logKind.length;
}

/**
 * The log's entries since `mark`, as a compile of ABC `index` added them,
 * a line each, its ABCs named by their place among those the ABC's
 * application domain sees: what domainReplay does again to leave the
 * domain as that compile did, when a host has the module from its cache.
 * "!" if an entry is of another kind, or of an ABC the domain does not see.
 */
export function domainLogSince(mark: i32, index: i32 = -1): string {
  const at = abcIndex(index);
  if (at < 0 || mark < 0) {
    return "!";
  }

  const seen = seenBy(domain.abcDomain[at]);
  const out: string[] = [];
  for (let e = mark; e < domain.logKind.length; e++) {
    const kind = domain.logKind[e];
    if (kind === LOG_None) {
      continue;
    }

    const place = placeOf(seen, domain.logAbc[e]);
    if (kind === LOG_Found || place < 0) {
      return "!";
    }

    out.push(`${kind} ${place} ${domain.logA[e]} ${domain.logB[e]}`);
  }

  return out.join("\n");
}

/**
 * Do again for ABC `index` what a compile of it added to the log, as
 * domainLogSince wrote it, without compiling: the lazy answers it fixed,
 * asked for again with the ABCs there now, which a host checks are those
 * of that compile (domainContext). False if an entry is malformed or comes
 * out an error; the entries before it are done.
 */
export function domainReplay(log: string, index: i32 = -1): bool {
  abandon();
  const at = abcIndex(index);
  if (at < 0) {
    return false;
  }

  verified = null;
  written = null;
  const rows = domain.rows();
  const seen = seenBy(domain.abcDomain[at]);
  const lines = log.length ? log.split("\n") : [];
  let ok = true;
  for (let l = 0; l < lines.length && ok; l++) {
    const parts = lines[l].split(" ");
    if (parts.length !== 4) {
      ok = false;
      break;
    }

    const kind = I32.parseInt(parts[0]);
    const place = I32.parseInt(parts[1]);
    const a = I32.parseInt(parts[2]);
    const b = I32.parseInt(parts[3]);
    if (place < 0 || place >= seen.length || a < 0 || b < 0) {
      ok = false;
      break;
    }

    const abc = seen[place];
    ok = replayed(<u8>kind, abc, <u32>a, <u32>b);
  }

  weigh(domain, <u32>at, rows);
  return ok;
}

/** Entry `kind` of ABC `abc` done again, as replay in avm2/link/lifetime.ts does one, its numbers checked against the ABC first. */
function replayed(kind: u8, abc: u32, a: u32, b: u32): bool {
  const info = domain.abcs[abc];
  if (kind === LOG_Verify) {
    verifyMethods(domain, abc);
    return true;
  }

  if (kind === LOG_Sign) {
    return b < info.methodCount && domain.traits.sign(domain, domain.methodStart[abc] + b) === 0;
  }

  if (kind !== LOG_Resolve || a < TRAITS_Instance || a > TRAITS_Activation) {
    return false;
  }

  const owners =
    a === TRAITS_Script
      ? info.scriptCount
      : a === TRAITS_Activation
        ? <u32>domain.bodyTraits[abc].length
        : info.classCount;
  const t = b < owners ? traitsOf(domain, abc, a, b) : -1;
  return t >= 0 && domain.traits.resolve(domain, <u32>t) === 0;
}

/** The live ABCs application domain `own` sees, by index, in load order, in a list kept from call to call. */
function seenBy(own: u32): u32[] {
  const seen = seenList;
  seen.length = 0;
  for (let i = 0; i < domain.abcs.length; i++) {
    if (domain.sees(own, domain.abcDomain[i])) {
      seen.push(<u32>i);
    }
  }

  return seen;
}

const seenList: u32[] = [];

/** ABC `abc`'s place in `seen`, or -1. */
function placeOf(seen: u32[], abc: u32): i32 {
  let low = 0;
  let high = seen.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (seen[mid] === abc) {
      return mid;
    }

    if (seen[mid] < abc) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return -1;
}

/** How many parents up from application domain `own` `other` is, or -1 if it is not `own` or an ancestor. */
function depthOf(own: u32, other: u32): i32 {
  let depth = 0;
  for (let d = <i32>own; d >= 0; d = domain.domainParent[d]) {
    if (<u32>d === other) {
      return depth;
    }

    depth++;
  }

  return -1;
}
