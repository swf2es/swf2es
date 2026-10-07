// The compiler as codegen.wasm exports it, and as the test build does too,
// so that the two builds run the same code: a domain the ABCs are added
// to, and the module, the source map and the method entries the last one
// compiles to, whole for ahead-of-time compilation or a method at a time
// as the JIT compiles them (see docs/architecture.md).
import { BodyDecoder, verifyMethods } from "./avm2/abc/code";
import * as C from "./avm2/abc/constants";
import { PADDING } from "./avm2/abc/reader";
import { ModuleEmitter } from "./avm2/emit/module";
import { Output } from "./avm2/emit/output";
import {
  DOMAIN_Live,
  Domain,
  LOG_Found,
  LOG_None,
  LOG_Resolve,
  LOG_Sign,
  LOG_Verify,
} from "./avm2/link/domain";
import { TRAITS_Activation, TRAITS_Instance, TRAITS_Script } from "./avm2/link/traits";

export let domain = new Domain();

// The last ABC's methods verified, kept for the JIT, which compiles them
// one at a time; another ABC added, or a new domain, starts over.
let verified: StaticArray<i32> | null = null;

/**
 * The emitter of the module domainModule wrote last, if it was kept: its
 * source map and entries are written when asked for, not with the module,
 * whose memory they would add to that call's. A large ABC's entries alone,
 * decoded, doubled codegen's memory, which never shrinks.
 */
let written: ModuleEmitter | null = null;

/** Start a new domain whose user ABCs have API version `apiVersion`. */
export function domainReset(apiVersion: i32): void {
  domain = new Domain();
  domain.apiVersion = <u8>apiVersion;
  verified = null;
  written = null;
}

/**
 * Add an ABC to the domain, loaded into application domain `appDomain`
 * (0, the root, or one domainChild made); 0, or the VerifyError it was
 * rejected with; -1 for an application domain never made or dropped.
 */
export function domainAdd(bytes: Uint8Array, builtin: bool, appDomain: i32 = 0): i32 {
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
  if (appDomain >= 0) {
    domain.drop(<u32>appDomain);
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
  if (appDomain >= 0) {
    domain.evict(<u32>appDomain);
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
  if (index < 0) {
    return -1;
  }

  const buffer = new StaticArray<u8>(bytes.length + PADDING);
  memory.copy(changetype<usize>(buffer), bytes.dataStart, bytes.length);
  return domain.restore(<u32>index, buffer, bytes.length);
}

/**
 * Make evicted application domain `appDomain` live again, with its evicted
 * ancestors, given again those of their ABCs domainRestore was asked for
 * (after a -1 here): their ABCs link again as they did, and what they
 * found holds, by one rebuild if one has been since any was evicted. 0, 1
 * after a rebuild, which a collection would free, or -1, leaving them
 * evicted, if they cannot be.
 */
export function domainRevive(appDomain: i32): i32 {
  if (appDomain < 0) {
    return -1;
  }

  const bottom = <u32>appDomain;
  const top = bottom < <u32>domain.domainState.length ? domain.evictedTop(bottom) : bottom;
  const revived = domain.revive(bottom);
  if (revived <= 0) {
    return revived;
  }

  if (!domainRebuild()) {
    domain.unrevive(bottom, top);
    return -1;
  }

  return 1;
}

/**
 * Rebuild the domain without the ABCs of domains not live, once memory
 * would otherwise grow and they hold enough to keep it from growing (see
 * Domain.wantsRebuild):
 * whether it was, and a collection would free them now. A host calls it
 * when it has time, as when idle, so a batch of drops and evictions costs
 * one rebuild. Later modules come out the same either way.
 */
export function domainCompact(): bool {
  return domain.wantsRebuild() && domainRebuild();
}

/**
 * The domain built again from its live ABCs (see Domain.rebuilt), worth it
 * or not, as the fuzzers ask; false, leaving it, if one did not link.
 */
export function domainRebuild(): bool {
  const fresh = domain.rebuilt();
  if (fresh === null) {
    return false;
  }

  // A closure's scope is found by verifying its ABC, which the JIT does
  // once for its first method: the new domain has none found yet.
  domain = fresh;
  verified = null;
  written = null;
  return true;
}

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
  written = null;
  // No ABC, no module: the caller asked before adding one.
  const at = abcIndex(index);
  if (at < 0) {
    return "";
  }

  const rows = domain.rows();
  const emitter = new ModuleEmitter(domain, <u32>at);
  emitter.module(hashes.length ? hashes.split("\n") : [], linkedOnly);
  domain.weigh(<u32>at, rows);
  if (keep) {
    written = emitter;
  }

  const out = emitter.out;
  return String.UTF8.decodeUnsafe(changetype<usize>(out.bytes), out.length);
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
 * Method bodies of ABC `which` (the last added for -1) compiled alone, as lazy JIT will
 * compile them: each its entry in F, as the module writes it. `bodies` are
 * their indices, comma-separated, in the order to compile them; `reuse`
 * compiles them all with one emitter, else each with a new one. The ABC is
 * verified once first, which a closure's scope needs. Written as
 * domainModuleEntries writes them, leaving out a native or an unverified.
 */
export function domainEmitEach(bodies: string, reuse: bool, which: i32 = -1): string {
  const at = abcIndex(which);
  if (at < 0) {
    return "";
  }

  const index = <u32>at;
  const abc = domain.abcs[index];
  const rows = domain.rows();
  const results = verifiedBodies(index);
  const decoder = new BodyDecoder(abc, domain.abcBase[index], domain, index);
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

  domain.weigh(index, rows);
  return String.UTF8.decodeUnsafe(changetype<usize>(entries.bytes), entries.length);
}

/**
 * Whether domainCompact would rebuild now: memory would grow before long
 * and the ABCs of dropped and evicted domains hold enough to keep it from
 * growing (see Domain.wantsRebuild). A pure query, so that a host collects
 * garbage before a rebuild only when one is due.
 */
export function domainWantsCompact(): bool {
  return domain.wantsRebuild();
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
  domain.addWeights();
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
 * the same ABCs loaded at other indices give the same context.
 */
export function domainContext(index: i32 = -1): string {
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
  for (let i = 0; i < seen.length; i++) {
    if (i > 0) {
      out.byte(0x2c);
    }

    out.uint(seen[i]);
  }

  out.byte(0x0a);
  out.uint(placeOf(seen, <u32>at));
  let count: u32 = 0;
  for (let e = 0; e < domain.logKind.length; e++) {
    // Visible ABCs added before the entry happened.
    while (count < <u32>seen.length && seen[count] < domain.logAt[e]) {
      count++;
    }

    const kind = domain.logKind[e];
    const place = placeOf(seen, domain.logAbc[e]);
    if (kind === LOG_None || place < 0) {
      continue;
    }

    const f = domain.logA[e];
    const depth = kind === LOG_Found ? depthOf(own, domain.foundDomain[f]) : 0;
    if (depth < 0) {
      continue;
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
      continue;
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
  }

  return String.UTF8.decodeUnsafe(changetype<usize>(out.bytes), out.length);
}

/** domainContext's buffer, kept from call to call. */
const context = new Output();

/** `s` as domainContext writes a name: its length, ":", and its code units, a backslash or one past ASCII escaped. */
function named(out: Output, s: string): void {
  out.uint(s.length);
  out.byte(0x3a);
  for (let i = 0; i < s.length; i++) {
    const c = <u32>s.charCodeAt(i);
    if (c < 0x80 && c !== 0x5c) {
      out.byte(<u8>c);
    } else {
      out.unit(c);
    }
  }
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

  domain.weigh(<u32>at, rows);
  return ok;
}

/** Entry `kind` of ABC `abc` done again, as Domain.replay does one, its numbers checked against the ABC first. */
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
  const t = b < owners ? domain.traitsOf(abc, a, b) : -1;
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
