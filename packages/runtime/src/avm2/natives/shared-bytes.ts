// A shareable ByteArray's memory between workers, as avmplus' ByteArrays
// share one Buffer: whether this thread can share memory, and each VM's
// one ByteArray for each shared memory.
//
// Translated from avmplus' core/ByteArrayGlue.cpp, this file is subject to
// the Mozilla Public License, v. 2.0: http://mozilla.org/MPL/2.0/.
import type { AsObject } from "../descriptors.js";
import type { Runtime } from "../runtime.js";
import { bytesOf } from "./bytes.js";

/**
 * A shareable ByteArray's memory once it has crossed to another worker,
 * which every worker's ByteArray for it uses, as avmplus' ByteArrays share
 * one Buffer: its bytes grow in place, and its length is one for all.
 * Plain data, which a structured clone carries to another thread.
 */
export interface SharedBytesMemory {
  /** The same in every worker, by which each VM keeps one ByteArray for it, as avmplus interns it. */
  id: number;
  /** Its words: the length, as a uint32. */
  meta: SharedArrayBuffer;
  /** Its bytes, as long as its capacity: growable, up to the most a ByteArray holds where it can. */
  data: SharedArrayBuffer;
}

/** The growable SharedArrayBuffer of ES2024, which the runtime's ES2022 library does not type. */
export interface GrowableShared {
  readonly byteLength: number;
  readonly maxByteLength: number;
  grow(length: number): void;
}

export type GrowableSharedConstructor = new (
  length: number,
  options: { maxByteLength: number },
) => SharedArrayBuffer;

/** The ways a browser serves a page cross-origin isolated, for the error a page that is not gets. */
const ISOLATION =
  "a cross-origin isolated page (served with Cross-Origin-Opener-Policy: same-origin and " +
  "Cross-Origin-Embedder-Policy: credentialless or require-corp)";

/**
 * Whether this thread can share memory with others: SharedArrayBuffer is
 * there, as node always has it, and a browser only for a page that is
 * cross-origin isolated.
 */
export function canShareMemory(): boolean {
  const g = globalThis as { crossOriginIsolated?: boolean };
  return typeof SharedArrayBuffer === "function" && g.crossOriginIsolated !== false;
}

/** What a page that is not cross-origin isolated gets for sharing `what` with another worker. */
export function notIsolated(what: string): Error {
  return new Error(
    `swf2es: sharing ${what} with another worker needs shared memory, which a browser gives only ${ISOLATION}`,
  );
}

/** Each runtime's ByteArray for each shared memory, by its id. */
const sharedObjects = new WeakMap<Runtime, Map<number, WeakRef<AsObject>>>();

export function sharedObjectsOf(rt: Runtime): Map<number, WeakRef<AsObject>> {
  let objects = sharedObjects.get(rt);
  if (!objects) {
    objects = new Map();
    sharedObjects.set(rt, objects);
  }

  return objects;
}

/**
 * A shareable ByteArray's memory, shared from now on, as it crosses to
 * another worker; where memory cannot be shared, the error that names
 * cross-origin isolation.
 */
export function shareBytes(rt: Runtime, o: AsObject): SharedBytesMemory {
  return bytesOf(rt, o).share();
}

/** This VM's one ByteArray for a shared memory, as avmplus interns one for its Buffer: shareable, at position 0. */
export function sharedByteArray(rt: Runtime, memory: SharedBytesMemory): AsObject {
  const objects = sharedObjectsOf(rt);
  const known = objects.get(memory.id)?.deref();
  if (known) {
    return known;
  }

  const o = rt.construct(rt.classNamed("flash.utils::ByteArray")) as AsObject;
  bytesOf(rt, o).adopt(memory);
  objects.set(memory.id, new WeakRef(o));
  return o;
}

/** This VM's ByteArray for the shared memory `id`, if it has one. */
export function knownSharedByteArray(rt: Runtime, id: number): AsObject | undefined {
  return sharedObjectsOf(rt).get(id)?.deref();
}
