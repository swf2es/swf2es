// The lifetimes of application domains: dropped for good, or evicted and
// revived, and the ABCs' weight in the tables, by which a rebuild, linking
// the live ABCs again into a new Domain and doing again what its log
// records, is found worth it.

import { Output } from "../../output";
import { Abc } from "../abc/abc";
import { VERIFY_COST, Verifier } from "../abc/code";
import { readAbc } from "../abc/parse";
import {
  ABC_Weight,
  DOMAIN_Dropped,
  DOMAIN_Evicted,
  DOMAIN_Live,
  Domain,
  LOG_Found,
  LOG_None,
  LOG_Resolve,
  LOG_Sign,
  LOG_Verify,
} from "./domain";
import { TRAITS_Class, TRAITS_Instance, TRAITS_Script } from "./traits";

/** What a log entry kept for an evicted domain weighs. */
const KEPT_Weight: u64 = 36;

/**
 * The most memory a rebuild elsewhere grows the new instance by at once:
 * the allocator's largest block is a gigabyte.
 */
export const MOVE_Limit: u64 = (1 << 30) - (1 << 20);

/** The size of memory below which a rebuild elsewhere is not worth it for shrinking it alone. */
const SHRINK_Floor: u64 = 32 << 20;

/** The weight of dead ABCs below which a rebuild is not worth it. */
const DEAD_Floor: u64 = 4 << 20;

/** Whether tables of `weight`, with what its estimate misses, come within `reserve` of `size`. */
function full(weight: u64, reserve: u64, size: u64): bool {
  return weight + (weight >> 2) + (weight >> 3) + reserve >= size;
}

/** What takes the place of an ABC let go of in a rebuilt Domain (see vacate). */
const NO_ABC = new Abc();
const NO_BYTES = new StaticArray<u8>(0);
const NO_IDS = new StaticArray<u32>(0);
const NO_VERSIONS = new StaticArray<u8>(0);
const NO_TRAITS = new StaticArray<i32>(0);

/** Count what the domain's tables gained since they held `rows` as ABC `index`'s. */
export function weigh(dom: Domain, index: u32, rows: u64): void {
  const now = dom.rows();
  if (now > rows && index < <u32>dom.abcWeight.length) {
    dom.abcWeight[index] = <u32>min<u64>(<u64>dom.abcWeight[index] + now - rows, 0xffffffff);
  }
}

/**
 * Take the place of an ABC of an application domain not live, with
 * nothing in it, so that the ABCs after it keep their indices.
 */
function vacate(dom: Domain, domain: u32): void {
  dom.abcs.push(NO_ABC);
  dom.abcDomain.push(domain);
  dom.abcBase.push(0);
  dom.abcBuffer.push(NO_BYTES);
  dom.abcVerified.push(0);
  dom.abcWeight.push(0);
  dom.loads++;
  dom.abcOwner.push(dom.loads);
  dom.methodStart.push(<u32>dom.traits.methodTraits.length);
  dom.abcString.push(NO_IDS);
  dom.abcNs.push(NO_IDS);
  dom.abcNsVersion.push(NO_VERSIONS);
  dom.classStart.push(<u32>dom.classAbc.length);
  dom.scriptTraits.push(NO_IDS);
  dom.bodyTraits.push(NO_TRAITS);
}

/**
 * Drop application domain `domain` and its descendants, as the runtime
 * lets go of them: what their ABCs define is seen by no domain from now
 * on, and they take no more ABCs. The root is never dropped.
 */
export function drop(dom: Domain, domain: u32): void {
  leave(dom, domain, DOMAIN_Dropped);
}

/**
 * Evict application domain `domain` and its live descendants: as
 * dropped, until revive, given their ABCs again, links them back.
 */
export function evict(dom: Domain, domain: u32): void {
  if (domain < <u32>dom.domainState.length && dom.domainState[domain] === DOMAIN_Live) {
    leave(dom, domain, DOMAIN_Evicted);
  }
}

/** Put `domain` and its descendants in `state`, unless dropped already; never the root. */
function leave(dom: Domain, domain: u32, state: u8): void {
  const count = <u32>dom.domainParent.length;
  if (domain === 0 || domain >= count || dom.domainState[domain] === DOMAIN_Dropped) {
    return;
  }

  // A child is made after its parent, so its number is higher.
  dom.domainState[domain] = state;
  dom.domainEvicted[domain] = dom.generation;
  for (let d = domain + 1; d < count; d++) {
    const parent = dom.domainState[<u32>dom.domainParent[d]];
    if (parent !== DOMAIN_Live && dom.domainState[d] < parent) {
      if (dom.domainState[d] === DOMAIN_Live) {
        dom.domainEvicted[d] = dom.generation;
      }

      dom.domainState[d] = parent;
    }
  }
}

/**
 * Give ABC `index`, of an evicted application domain, its bytes again,
 * if a rebuild has let go of them, for revive to link it: 0, the
 * VerifyError they were rejected with, or -1 if they are not the ABC's.
 */
export function restore(dom: Domain, index: u32, buffer: StaticArray<u8>, length: u32): i32 {
  if (index >= <u32>dom.abcs.length || dom.domainState[dom.abcDomain[index]] !== DOMAIN_Evicted) {
    return -1;
  }

  if (dom.abcs[index] !== NO_ABC) {
    return 0;
  }

  const abc = readAbc(changetype<usize>(buffer), length, false);
  if (abc.error) {
    return abc.error;
  }

  dom.abcs[index] = abc;
  dom.abcBase[index] = changetype<usize>(buffer);
  dom.abcBuffer[index] = buffer;
  dom.abcWeight[index] = <u32>min<u64>(ABC_Weight * <u64>length, 0xffffffff);
  return 0;
}

/**
 * Make evicted application domain `domain` live again, with its evicted
 * ancestors, the first of them a child of a live one: 0 if their ABCs
 * and findings are in the tables still, as no rebuild has been since
 * any was evicted, 1 if a rebuild must link them again, and -1, leaving
 * them evicted, if they cannot be: `domain` is not evicted, the first
 * evicted ancestor's parent is not live, or an ABC of theirs that a
 * rebuild let go of was not restored.
 */
export function revive(dom: Domain, domain: u32): i32 {
  if (
    domain === 0 ||
    domain >= <u32>dom.domainState.length ||
    dom.domainState[domain] !== DOMAIN_Evicted
  ) {
    return -1;
  }

  let top = domain;
  while (dom.domainState[<u32>dom.domainParent[top]] === DOMAIN_Evicted) {
    top = <u32>dom.domainParent[top];
  }

  if (dom.domainState[<u32>dom.domainParent[top]] !== DOMAIN_Live) {
    return -1;
  }

  for (let i = 0; i < dom.abcs.length; i++) {
    if (dom.abcs[i] === NO_ABC && inChain(dom, dom.abcDomain[i], top, domain)) {
      return -1;
    }
  }

  let stale = false;
  for (let d = domain; ; d = <u32>dom.domainParent[d]) {
    stale = stale || dom.domainEvicted[d] !== dom.generation;
    dom.domainState[d] = DOMAIN_Live;
    if (d === top) {
      break;
    }
  }

  return stale ? 1 : 0;
}

/** Make `domain` and its ancestors up to `top` evicted again, as revive found them. */
export function unrevive(dom: Domain, domain: u32, top: u32): void {
  for (let d = domain; ; d = <u32>dom.domainParent[d]) {
    dom.domainState[d] = DOMAIN_Evicted;
    if (d === top) {
      break;
    }
  }
}

/** The first evicted ancestor of `domain` from the root down, or `domain` itself. */
export function evictedTop(dom: Domain, domain: u32): u32 {
  let top = domain;
  while (dom.domainState[<u32>dom.domainParent[top]] === DOMAIN_Evicted) {
    top = <u32>dom.domainParent[top];
  }

  return top;
}

/** Whether `d` is `bottom` or one of its ancestors up to `top`. */
function inChain(dom: Domain, d: u32, top: u32, bottom: u32): bool {
  let x = bottom;
  while (x !== d && x !== top) {
    x = <u32>dom.domainParent[x];
  }

  return x === d;
}

/**
 * Whether a rebuild, which links every live ABC again and does again
 * what resolved lazily, is worth it now, a part of `part` bytes of
 * garbage at a time (see Rebuild), in this instance's memory or, with
 * `elsewhere`, in another's (see saveDomain). The tables count by the
 * ABCs' weight with three eighths more for what the estimate misses; the
 * reserve is what the next loads may add, twice the largest of the last
 * 16 ABCs' weights and a part's garbage, a sixteenth to a half of memory.
 *
 * Elsewhere, the other instance's memory holds the live tables alone,
 * and this one's goes with it. It is due once the tables come within the
 * reserve of wasm memory's size, which a load would then grow, and the
 * ABCs of domains not live weigh DEAD_Floor, a sixteenth of memory and a
 * quarter of the live ones', as a large application's rebuild takes
 * seconds; or once memory is four times what the other instance would
 * take (rebuiltSize), and SHRINK_Floor, as a large compile, or the dead
 * tables of a session, left it. And only where that instance would take
 * an eighth less than this one at least, or a rebuild in place would not
 * fit, and less than MOVE_Limit, the largest block it can grow by.
 *
 * In place, the new tables are made beside the old and the dead ones, so
 * it is done only while the three and a part's garbage fit in memory,
 * which never shrinks, by an estimate closer than full's, and once a few
 * more loads, a reserve, would leave them no room; for dead ones of an
 * eighth of memory and half the live ones', so that it is not done every
 * few loads; and, where there is a `spare` instance, only if a move would
 * not take less memory, as for a small domain, whose new instance's
 * margins weigh more than it: else a move, once memory would grow, frees
 * the old tables' room too, and is done less often. Past that it waits:
 * memory then grows as the loads need it, not by twice its size at once.
 */
export function wantsRebuild(dom: Domain, part: u64, elsewhere: bool, spare: bool): bool {
  addWeights(dom);
  const size = (<u64>memory.size()) << 16;
  let largest: u64 = 0;
  let largestLive: u64 = 0;
  const count = dom.abcWeight.length;
  for (let i = 0; i < count; i++) {
    if (i >= count - 16) {
      largest = max<u64>(largest, dom.abcWeight[i]);
    }

    if (dom.abcs[i] !== NO_ABC && dom.isLive(<u32>i)) {
      largestLive = max<u64>(largestLive, dom.abcWeight[i]);
    }
  }

  // A part may make more garbage than its budget counts.
  const garbage = part << 1;
  const reserve = min(size >> 1, max(size >> 4, (largest << 1) + garbage));
  const live = dom.liveWeight + dom.keptWeight;
  const dead = dom.deadWeight;
  const rebuilt = rebuiltSize(live, largestLive, part);
  const smaller = rebuilt <= size - (size >> 3);
  // The old tables, the dead and the new, by a closer estimate than full's,
  // which would leave a small domain's rebuild in place never fitting:
  // before a rebuild the heap held about the tables' weight.
  const beside = live + dead + live;
  const fits = beside + (beside >> 3) + part < size;
  if (elsewhere) {
    const worth = dead >= max(max(DEAD_Floor, size >> 4), live >> 2);
    return (
      ((worth && full(live + dead, reserve, size)) || size >= max(SHRINK_Floor, rebuilt << 2)) &&
      (smaller || !fits) &&
      rebuilt < MOVE_Limit
    );
  }

  return (
    !(spare && smaller) &&
    dead >= max(max(DEAD_Floor, size >> 3), live >> 1) &&
    fits &&
    beside + (beside >> 3) + part + reserve >= size &&
    !full(live, reserve, size)
  );
}

/**
 * The memory a rebuild elsewhere grows the new instance to at once, for
 * live ABCs of weight `live`, the largest `largest`, rebuilt a part of
 * `part` bytes of garbage at a time: their tables, with three eighths more
 * for what the estimate misses and a quarter more for the loads after,
 * and the garbage of linking the largest again, which is one step, and of
 * a part. Grown as it fills instead, each time by as much again as it
 * has, memory came to twice what it held, and a size that fell short by
 * a little doubled it as well: a large application's rebuild needed more
 * than one and a half times its live ABCs' weight while it ran.
 */
export function rebuiltSize(live: u64, largest: u64, part: u64): u64 {
  const tables = live + (live >> 2) + (live >> 3);
  return tables + (tables >> 2) + (largest << 1) + (part << 1);
}

/** Add up liveWeight and deadWeight. */
export function addWeights(dom: Domain): void {
  let dead: u64 = 0;
  let live: u64 = 0;
  for (let i = 0; i < dom.abcs.length; i++) {
    if (dom.abcs[i] === NO_ABC) {
      continue;
    }

    if (dom.isLive(<u32>i)) {
      live += dom.abcWeight[i];
    } else {
      dead += dom.abcWeight[i];
    }
  }

  dom.liveWeight = live;
  dom.deadWeight = dead;
}

/** The traits of ABC `abc` of `kind` and `owner`, as loggedResolve logged them, or -1. */
export function traitsOf(dom: Domain, abc: u32, kind: u32, owner: u32): i32 {
  if (kind === TRAITS_Instance) {
    return dom.classTraits[dom.classStart[abc] + owner];
  }

  if (kind === TRAITS_Class) {
    return dom.classStatic[dom.classStart[abc] + owner];
  }

  if (kind === TRAITS_Script) {
    return <i32>dom.scriptTraits[abc][owner];
  }

  return dom.bodyTraits[abc][owner];
}

/**
 * A new Domain with the live ABCs linked again, in the same order and
 * at the same indices, and the log done again where it happened: each
 * finding of a live domain recorded, and each lazy answer about a live
 * ABC asked for again, with the same ABCs there as when it was first
 * asked, so it is the same; an evicted domain's entries are kept for its
 * revival. Nothing of the other ABCs is left in it, not even a name only
 * they spelled. Each live ABC links as it did, since no ABC let go of was
 * seen by a live one, and what a method compiles to depends only on the
 * ABCs its domain sees and on those answers, so it compiles alike.
 *
 * Made a part at a time, so that a host may collect each part's garbage
 * before the next: step until it returns true, with nothing else changing
 * the domain or decoding in between. A large application's rebuild
 * verifies every verified ABC again, whose garbage, made in one call, took
 * more memory than the new tables. The parts do the same in the same
 * order, however they are cut; `fresh` is the new Domain once done, or
 * null, leaving the old one as it was, if an ABC did not link again or an
 * answer came out an error, which would be a bug.
 */
@final
export class Rebuild {
  fresh: Domain | null;
  private dom: Domain;
  private entry: i32 = 0;
  private next: u32 = 0;
  private verifier: Verifier | null = null;
  private done: bool = false;

  constructor(dom: Domain) {
    const fresh = new Domain();
    fresh.apiVersion = dom.apiVersion;
    fresh.domainParent = dom.domainParent;
    fresh.domainDepth = dom.domainDepth;
    fresh.domainState = dom.domainState;
    fresh.domainEvicted = dom.domainEvicted;
    fresh.generation = dom.generation + 1;
    this.dom = dom;
    this.fresh = fresh;
  }

  /**
   * Go on until this call has made about `budget` bytes of garbage, as
   * the code it verified (VERIFY_COST) and the ABCs it linked again count
   * it, and at least one step: whether done.
   */
  step(budget: u64): bool {
    const dom = this.dom;
    const fresh = this.fresh;
    if (this.done || fresh === null) {
      return true;
    }

    const count = <u32>dom.abcs.length;
    let spent: u64 = 0;
    for (; this.entry <= dom.logKind.length; this.entry++) {
      const e = this.entry;
      const at = e < dom.logKind.length ? dom.logAt[e] : count;
      for (; this.next < at; this.next++) {
        if (spent >= budget) {
          return false;
        }

        if (!reattach(dom, fresh, this.next)) {
          return this.fail();
        }

        spent += <u64>dom.abcs[this.next].length;
      }

      if (e === dom.logKind.length) {
        break;
      }

      let verifier = this.verifier;
      if (verifier !== null) {
        // A verification under way, from the step before.
        if (!verifier.run(max<u64>((budget - min(spent, budget)) / VERIFY_COST, 1))) {
          return false;
        }

        this.verifier = null;
        spent += verifier.spent * VERIFY_COST;
        continue;
      }

      if (spent >= budget) {
        return false;
      }

      const kind = dom.logKind[e];
      const abc = dom.logAbc[e];
      const state =
        kind === LOG_Found
          ? max(dom.domainState[dom.foundDomain[dom.logA[e]]], dom.domainState[dom.abcDomain[abc]])
          : dom.domainState[dom.abcDomain[abc]];
      if (kind === LOG_None || state === DOMAIN_Dropped) {
        continue;
      }

      if (state === DOMAIN_Evicted || dom.abcs[abc] === NO_ABC) {
        keepEntry(fresh, dom, e);
        continue;
      }

      if (kind === LOG_Verify) {
        verifier = new Verifier(fresh, abc);
        if (!verifier.run(max<u64>((budget - spent) / VERIFY_COST, 1))) {
          this.verifier = verifier;
          return false;
        }

        spent += verifier.spent * VERIFY_COST;
        continue;
      }

      if (!replay(fresh, dom, e)) {
        return this.fail();
      }
    }

    this.done = true;
    return true;
  }

  private fail(): bool {
    this.fresh = null;
    this.verifier = null;
    this.done = true;
    return true;
  }
}

/** Link ABC `index` of `dom` again as `fresh`'s next, or keep its place if it is not live: false if it does not link. */
function reattach(dom: Domain, fresh: Domain, index: u32): bool {
  const abc = dom.abcs[index];
  if (abc === NO_ABC || !dom.isLive(index)) {
    vacate(fresh, dom.abcDomain[index]);
    return true;
  }

  const buffer = dom.abcBuffer[index];
  fresh.buffers.push(buffer);
  if (!fresh.attach(abc, buffer, dom.abcDomain[index])) {
    abc.error = 0;
    return false;
  }

  // Its weight counts what compiling it added too.
  fresh.abcWeight[index] = max(fresh.abcWeight[index], dom.abcWeight[index]);
  return true;
}

/** Do entry `e` of `from`'s log again, a finding or a lazy answer, its ABC linked: false if it comes out an error. */
function replay(dom: Domain, from: Domain, e: i32): bool {
  const kind = from.logKind[e];
  const abc = from.logAbc[e];
  if (kind === LOG_Found) {
    const f = from.logA[e];
    dom.addFound(
      from.foundDomain[f],
      from.foundKind[f],
      from.foundUri[f],
      from.foundName[f],
      from.foundAbc[f],
      from.foundAsType[f] !== 0,
    );
    return true;
  }

  if (kind === LOG_Resolve) {
    const t = traitsOf(dom, abc, from.logA[e], from.logB[e]);
    return t >= 0 && dom.traits.resolve(dom, <u32>t) === 0;
  }

  return kind === LOG_Sign && dom.traits.sign(dom, dom.methodStart[abc] + from.logB[e]) === 0;
}

/** Keep entry `e` of `from`'s log, not done, for when its domain is revived. */
function keepEntry(dom: Domain, from: Domain, e: i32): void {
  let a = from.logA[e];
  if (from.logKind[e] === LOG_Found) {
    a = <u32>dom.foundDomain.length;
    dom.foundEntry.push(<u32>dom.logKind.length);
    dom.foundDomain.push(from.foundDomain[from.logA[e]]);
    dom.foundKind.push(from.foundKind[from.logA[e]]);
    dom.foundUri.push(from.foundUri[from.logA[e]]);
    dom.foundName.push(from.foundName[from.logA[e]]);
    dom.foundAbc.push(from.foundAbc[from.logA[e]]);
    dom.foundAsType.push(from.foundAsType[from.logA[e]]);
  }

  dom.keptWeight += KEPT_Weight;
  dom.logKind.push(from.logKind[e]);
  dom.logAt.push(from.logAt[e]);
  dom.logAbc.push(from.logAbc[e]);
  dom.logA.push(a);
  dom.logB.push(from.logB[e]);
}

/**
 * What a rebuild reads of `dom` (see Rebuild), but the ABCs' bytes, as
 * words, for another instance to rebuild it in a memory of its own
 * (loadDomain): the API version, the rebuilds since the reset, each
 * application domain's parent, depth, state and rebuild it was evicted
 * in, each ABC's domain and weight, whether it is live, a library's and
 * how long, the log, and the findings. wasm memory never shrinks, so
 * a rebuild in place leaves it as large as the old tables and the new
 * together, for good.
 */
export function saveDomain(dom: Domain, out: Output): void {
  out.reset();
  word(out, SAVED_Version);
  word(out, dom.apiVersion);
  word(out, dom.generation);
  const domains = dom.domainParent.length;
  word(out, domains);
  for (let d = 0; d < domains; d++) {
    word(out, <u32>dom.domainParent[d]);
    word(out, dom.domainDepth[d]);
    word(out, dom.domainState[d]);
    word(out, dom.domainEvicted[d]);
  }

  const abcs = dom.abcs.length;
  word(out, abcs);
  for (let i = 0; i < abcs; i++) {
    const abc = dom.abcs[i];
    const kept = abc !== NO_ABC && dom.isLive(<u32>i);
    word(out, dom.abcDomain[i]);
    word(out, dom.abcWeight[i]);
    word(out, (kept ? SAVED_Live : 0) | (abc.builtin ? SAVED_Builtin : 0));
    word(out, kept ? abc.length : 0);
  }

  const entries = dom.logKind.length;
  word(out, entries);
  for (let e = 0; e < entries; e++) {
    word(out, dom.logKind[e]);
    word(out, dom.logAt[e]);
    word(out, dom.logAbc[e]);
    word(out, dom.logA[e]);
    word(out, dom.logB[e]);
  }

  const found = dom.foundDomain.length;
  word(out, found);
  for (let f = 0; f < found; f++) {
    word(out, dom.foundDomain[f]);
    word(out, dom.foundKind[f]);
    word(out, dom.foundAbc[f]);
    word(out, dom.foundAsType[f]);
    units(out, dom.foundUri[f]);
    units(out, dom.foundName[f]);
  }
}

/** Whether ABC `index` of `dom` is one saveDomain names live, whose bytes the other instance is given. */
export function savedLive(dom: Domain, index: u32): bool {
  return index < <u32>dom.abcs.length && dom.abcs[index] !== NO_ABC && dom.isLive(index);
}

/** The bytes of ABC `index` of `dom`, as added. */
export function savedBytes(dom: Domain, index: u32): usize {
  return changetype<usize>(dom.abcBuffer[index]);
}

/** saveDomain's format, which loadDomain refuses another of. */
const SAVED_Version: u32 = 1;
const SAVED_Live: u32 = 1;
const SAVED_Builtin: u32 = 2;

function word(out: Output, value: u32): void {
  out.reserve(4);
  store<u32>(changetype<usize>(out.bytes) + out.length, value);
  out.length += 4;
}

function units(out: Output, s: string): void {
  word(out, <u32>s.length);
  for (let i = 0; i < s.length; i++) {
    word(out, <u32>s.charCodeAt(i));
  }
}

/**
 * A Domain as saveDomain saved one, for a Rebuild of it: its live ABCs
 * not yet given (see loadAbc), the rest in their places as a rebuild
 * leaves them; and what saveDomain said of each ABC.
 */
@final
export class Loaded {
  dom: Domain = new Domain();
  flags: u8[] = [];
  lengths: u32[] = [];
}

/** A Domain as saveDomain saved one (see Loaded); null if the words are not saveDomain's. */
export function loadDomain(words: Uint8Array): Loaded | null {
  const reader = new Words(words);
  if (reader.next() !== SAVED_Version) {
    return null;
  }

  const loaded = new Loaded();
  const dom = loaded.dom;
  dom.apiVersion = <u8>reader.next();
  dom.generation = reader.next();
  const domains = reader.count(4);
  dom.domainParent = [];
  dom.domainDepth = [];
  dom.domainState = [];
  dom.domainEvicted = [];
  for (let d: u32 = 0; d < domains; d++) {
    dom.domainParent.push(<i32>reader.next());
    dom.domainDepth.push(reader.next());
    dom.domainState.push(<u8>reader.next());
    dom.domainEvicted.push(reader.next());
  }

  const abcs = reader.count(4);
  for (let i: u32 = 0; i < abcs; i++) {
    dom.abcs.push(NO_ABC);
    dom.abcDomain.push(reader.next());
    dom.abcWeight.push(reader.next());
    loaded.flags.push(<u8>reader.next());
    loaded.lengths.push(reader.next());
    dom.abcBuffer.push(NO_BYTES);
    dom.abcBase.push(0);
  }

  const entries = reader.count(5);
  for (let e: u32 = 0; e < entries; e++) {
    dom.logKind.push(<u8>reader.next());
    dom.logAt.push(reader.next());
    dom.logAbc.push(reader.next());
    dom.logA.push(reader.next());
    dom.logB.push(reader.next());
  }

  const found = reader.count(6);
  for (let f: u32 = 0; f < found; f++) {
    dom.foundDomain.push(reader.next());
    dom.foundKind.push(<u8>reader.next());
    dom.foundAbc.push(reader.next());
    dom.foundAsType.push(<u8>reader.next());
    dom.foundUri.push(reader.text());
    dom.foundName.push(reader.text());
  }

  return reader.failed || !consistent(dom) ? null : loaded;
}

/** Whether what a Rebuild indexes by a loaded Domain's numbers is in range, as saveDomain wrote them. */
function consistent(dom: Domain): bool {
  const domains = <u32>dom.domainParent.length;
  const abcs = <u32>dom.abcs.length;
  if (domains === 0) {
    return false;
  }

  for (let d: u32 = 0; d < domains; d++) {
    const parent = dom.domainParent[d];
    if ((d === 0 ? parent !== -1 : parent < 0 || <u32>parent >= d) || dom.domainState[d] > 2) {
      return false;
    }
  }

  for (let i: u32 = 0; i < abcs; i++) {
    if (dom.abcDomain[i] >= domains) {
      return false;
    }
  }

  for (let f = 0; f < dom.foundDomain.length; f++) {
    if (dom.foundDomain[f] >= domains || dom.foundAbc[f] >= abcs) {
      return false;
    }
  }

  let at: u32 = 0;
  for (let e = 0; e < dom.logKind.length; e++) {
    const kind = dom.logKind[e];
    if (
      dom.logAt[e] < at ||
      dom.logAt[e] > abcs ||
      dom.logAbc[e] >= abcs ||
      kind > LOG_Verify ||
      (kind === LOG_Found && dom.logA[e] >= <u32>dom.foundDomain.length)
    ) {
      return false;
    }

    at = dom.logAt[e];
  }

  return true;
}

/**
 * Give ABC `index` of a Domain loadDomain made its bytes, as added: 0, -1
 * if it is not one saveDomain named live or is not the length it named,
 * or the VerifyError the bytes were rejected with.
 */
export function loadAbc(loaded: Loaded, index: u32, buffer: StaticArray<u8>, length: u32): i32 {
  const dom = loaded.dom;
  if (
    index >= <u32>dom.abcs.length ||
    !(loaded.flags[index] & SAVED_Live) ||
    dom.abcs[index] !== NO_ABC ||
    length !== loaded.lengths[index]
  ) {
    return -1;
  }

  const abc = readAbc(
    changetype<usize>(buffer),
    length,
    (loaded.flags[index] & SAVED_Builtin) !== 0,
  );
  if (abc.error) {
    return abc.error;
  }

  dom.abcs[index] = abc;
  dom.abcBase[index] = changetype<usize>(buffer);
  dom.abcBuffer[index] = buffer;
  return 0;
}

/** rebuiltSize for a Domain loadDomain made: the memory the instance rebuilding it is grown to. */
export function loadedSize(loaded: Loaded, part: u64): u64 {
  const dom = loaded.dom;
  let live: u64 = 0;
  let largest: u64 = 0;
  for (let i = 0; i < dom.abcs.length; i++) {
    if (loaded.flags[i] & SAVED_Live) {
      live += dom.abcWeight[i];
      largest = max<u64>(largest, dom.abcWeight[i]);
    }
  }

  return rebuiltSize(live, largest, part);
}

/** Whether every ABC saveDomain named live has been given its bytes (loadAbc). */
export function loadedAll(loaded: Loaded): bool {
  const dom = loaded.dom;
  for (let i = 0; i < dom.abcs.length; i++) {
    if (loaded.flags[i] & SAVED_Live && dom.abcs[i] === NO_ABC) {
      return false;
    }
  }

  return true;
}

/** saveDomain's words, read in turn, failing rather than reading past them. */
@final
class Words {
  failed: bool = false;
  private at: i32 = 0;

  constructor(private words: Uint8Array) {}

  next(): u32 {
    if (this.at + 4 > this.words.length) {
      this.failed = true;
      return 0;
    }

    const value = load<u32>(this.words.dataStart + <usize>this.at);
    this.at += 4;
    return value;
  }

  /** A count of things of `size` words each, refused if more than the words left could hold. */
  count(size: i32): u32 {
    const n = this.next();
    if (<u64>n * <u64>size * 4 > <u64>(this.words.length - this.at)) {
      this.failed = true;
      return 0;
    }

    return n;
  }

  text(): string {
    const length = this.count(1);
    const units = new Array<i32>(length);
    for (let i: u32 = 0; i < length; i++) {
      units[i] = <i32>this.next();
    }

    return String.fromCharCodes(units);
  }
}
