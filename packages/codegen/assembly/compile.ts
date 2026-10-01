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
import { Domain } from "./avm2/link/domain";

export let domain = new Domain();

// The last ABC's methods verified, kept for the JIT, which compiles them
// one at a time; another ABC added, or a new domain, starts over.
let verified: StaticArray<i32> | null = null;

/** Start a new domain whose user ABCs have API version `apiVersion`. */
export function domainReset(apiVersion: i32): void {
  domain = new Domain();
  domain.apiVersion = <u8>apiVersion;
  verified = null;
}

/** Add an ABC to the domain; 0, or the VerifyError it was rejected with. */
export function domainAdd(bytes: Uint8Array, builtin: bool): i32 {
  const buffer = new StaticArray<u8>(bytes.length + PADDING);
  memory.copy(changetype<usize>(buffer), bytes.dataStart, bytes.length);
  verified = null;
  return domain.add(buffer, bytes.length, builtin).error;
}

/** Each body of the last ABC's VerifyError, 0 if it verified, -1 if nothing runs it; verified once. */
function verifiedBodies(index: u32): StaticArray<i32> {
  let results = verified;
  if (results === null) {
    results = verifyMethods(domain, index);
    verified = results;
  }

  return results;
}

/**
 * The ES module the domain's last ABC compiles to; `hashes` are the ABCs'
 * hashes in load order, one per line.
 */
export function domainModule(hashes: string = ""): string {
  // No ABC, no module: the caller asked before adding one.
  if (domain.abcs.length === 0) {
    lastSourceMap = "";
    lastEntries = "";
    return "";
  }

  const emitter = new ModuleEmitter(domain, <u32>(domain.abcs.length - 1));
  emitter.module(hashes.length ? hashes.split("\n") : []);
  const out = emitter.out;
  const map = new Output();
  emitter.sourceMap(map);
  lastSourceMap = String.UTF8.decodeUnsafe(changetype<usize>(map.bytes), map.length);
  // The entries' bytes copied into one buffer, decoded once.
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

  lastEntries = String.UTF8.decodeUnsafe(changetype<usize>(entries.bytes), entries.length);
  return String.UTF8.decodeUnsafe(changetype<usize>(out.bytes), out.length);
}

let lastSourceMap = "";
let lastEntries = "";

/** The source map of the module domainModule wrote last, as JSON: its code's AS3 lines, from debugline. */
export function domainSourceMap(): string {
  return lastSourceMap;
}

/**
 * Method bodies of the domain's last ABC compiled alone, as lazy JIT will
 * compile them: each its entry in F, as the module writes it. `bodies` are
 * their indices, comma-separated, in the order to compile them; `reuse`
 * compiles them all with one emitter, else each with a new one. The ABC is
 * verified once first, which a closure's scope needs. Written as
 * domainModuleEntries writes them, leaving out a native or an unverified.
 */
export function domainEmitEach(bodies: string, reuse: bool): string {
  if (domain.abcs.length === 0) {
    return "";
  }

  const index = <u32>(domain.abcs.length - 1);
  const abc = domain.abcs[index];
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

    const body = <u32>I32.parseInt(list[k]);
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

  return String.UTF8.decodeUnsafe(changetype<usize>(entries.bytes), entries.length);
}

/**
 * The compiled methods' entries in F of the module domainModule wrote last:
 * for each, its body's index, U+0001, its entry, U+0002.
 */
export function domainModuleEntries(): string {
  return lastEntries;
}
