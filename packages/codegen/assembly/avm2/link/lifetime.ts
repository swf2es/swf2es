// The lifetimes of application domains: dropped for good, or evicted and
// revived, and the ABCs' weight in the tables, by which a rebuild, linking
// the live ABCs again into a new Domain and doing again what its log
// records, is found worth it.

import { Abc } from "../abc/abc";
import { verifyMethods } from "../abc/code";
import { readAbc } from "../abc/parse";
import {
  DOMAIN_Dropped,
  DOMAIN_Evicted,
  DOMAIN_Live,
  Domain,
  LOG_Found,
  LOG_None,
  LOG_Resolve,
  LOG_Sign,
} from "./domain";
import { TRAITS_Class, TRAITS_Instance, TRAITS_Script } from "./traits";

/** What a log entry kept for an evicted domain weighs. */
const KEPT_Weight: u64 = 36;

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
  dom.abcWeight[index] = <u32>min<u64>(3 * <u64>length, 0xffffffff);
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
 * what resolved lazily, would keep memory from growing: the tables, by
 * the ABCs' weight with three eighths more for what the estimate misses, have
 * come within a reserve of wasm memory's size, and the ABCs of domains
 * not live weigh DEAD_Floor and enough that the live ones alone are not.
 * The reserve is what a compile's garbage may take between collections,
 * which grows with the ABCs compiled: 16 times the weight of the last 16
 * added, a sixteenth to a half of memory; and what the rebuild itself
 * takes, twice the live tables. wasm memory never shrinks, so
 * a rebuild before that reclaims nothing it would grow for, and one that
 * could not get below is no use.
 */
export function wantsRebuild(dom: Domain): bool {
  addWeights(dom);
  const size = (<u64>memory.size()) << 16;
  let recent: u64 = 0;
  const count = dom.abcWeight.length;
  for (let i = max(0, count - 16); i < count; i++) {
    recent += dom.abcWeight[i];
  }

  const reserve = min(size >> 1, max(size >> 4, recent << 4));
  // A rebuild makes the live tables anew, and as much again in garbage
  // as they grow, while the old are there still.
  const live = dom.liveWeight + dom.keptWeight;
  const rebuilding = 2 * (live + (live >> 2) + (live >> 3));
  return (
    full(live + dom.deadWeight, reserve + rebuilding, size) &&
    dom.deadWeight >= DEAD_Floor &&
    !full(live, reserve, size)
  );
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
 * ABCs its domain sees and on those answers, so it compiles alike. Null,
 * leaving dom one as it was, if an ABC does not link again or an answer
 * comes out an error, which would be a bug.
 */
export function rebuilt(dom: Domain): Domain | null {
  const fresh = new Domain();
  fresh.apiVersion = dom.apiVersion;
  fresh.domainParent = dom.domainParent;
  fresh.domainDepth = dom.domainDepth;
  fresh.domainState = dom.domainState;
  fresh.domainEvicted = dom.domainEvicted;
  fresh.generation = dom.generation + 1;
  const count = <u32>dom.abcs.length;
  let next: u32 = 0;
  for (let e = 0; e <= dom.logKind.length; e++) {
    const at = e < dom.logKind.length ? dom.logAt[e] : count;
    for (; next < at; next++) {
      if (!reattach(dom, fresh, next)) {
        return null;
      }
    }

    if (e === dom.logKind.length) {
      break;
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

    if (!replay(fresh, dom, e)) {
      return null;
    }
  }

  return fresh;
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

/** Do entry `e` of `from`'s log again, its ABC linked: false if it comes out an error. */
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

  if (kind === LOG_Sign) {
    return dom.traits.sign(dom, dom.methodStart[abc] + from.logB[e]) === 0;
  }

  verifyMethods(dom, abc);
  return true;
}

/** Keep entry `e` of `from`'s log, not done, for when its domain is revived. */
function keepEntry(dom: Domain, from: Domain, e: i32): void {
  let a = from.logA[e];
  if (from.logKind[e] === LOG_Found) {
    a = <u32>dom.foundDomain.length;
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
