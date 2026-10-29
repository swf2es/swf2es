// The AVM1 compiler as codegen.wasm exports it, and as the test build does
// too: a SWF's action blocks, given as ranges of its bytes in the order
// format's readActions lists them, compiled to one module, and each block
// alone, as its entry in the module (the JIT/AOT invariant of
// docs/architecture/overview.md), and each unit a block goes on in alone, as its
// entry in the module's units. Nothing is kept from one SWF to the next
// but the emitter's buffers.
import { handOut, Output } from "../output";
import { ModuleEmitter } from "./emit/module";

/** Keep entry text without retaining the compiler's reusable analysis storage. */
@final
class WrittenActions {
  constructor(
    public out: Output,
    public entryStart: u32[],
    public entryEnd: u32[],
    public unitKeys: string[],
    public unitOf: i32[],
    public unitNumbers: i32[],
    public unitIndex: i32[],
    public unitHigh: i64[],
    public unitReach: i64[],
    public unitStart: u32[],
    public unitEnd: u32[],
  ) {}
}

let written: WrittenActions | null = null;

/**
 * The ES module of a SWF of version `version` whose blocks are
 * `lengths[k]` bytes from `offsets[k]` in `swf`, its decompressed bytes, as
 * UTF-8 handed out where it is (handOut); with `keep`, its entries for
 * actionsModuleEntries.
 */
export function actionsModuleBytes(
  swf: Uint8Array,
  offsets: Int32Array,
  lengths: Int32Array,
  version: i32,
  keep: bool = false,
): usize {
  written = null;
  const emitter = new ModuleEmitter();
  emitter.module(swf, offsets, lengths, version);
  if (keep) {
    written = new WrittenActions(
      emitter.out,
      emitter.entryStart,
      emitter.entryEnd,
      emitter.unitKeys,
      emitter.unitOf,
      emitter.unitNumbers,
      emitter.unitIndex,
      emitter.unitHigh,
      emitter.unitReach,
      emitter.unitStart,
      emitter.unitEnd,
    );
  }

  return handOut(emitter.out);
}

/**
 * The blocks' entries in the module actionsModuleBytes kept last: for each,
 * its index, U+0001, its entry, U+0002, as domainModuleEntries writes a
 * method's.
 */
export function actionsModuleEntries(): string {
  const emitter = written;
  if (emitter === null) {
    return "";
  }

  const out = emitter.out;
  const entries = new Output();
  for (let k = 0; k < emitter.entryStart.length; k++) {
    const start = emitter.entryStart[k];
    const length = emitter.entryEnd[k] - start;
    entries.uint(k);
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
 * The units of the module actionsModuleBytes kept last: for each, its key,
 * U+0001, the four numbers it was compiled for as V.far's, joined with
 * commas, U+0001, its high and reach joined with a comma, U+0001, its
 * entry, U+0002.
 */
export function actionsModuleUnits(): string {
  const emitter = written;
  if (emitter === null) {
    return "";
  }

  const out = emitter.out;
  const entries = new Output();
  for (let i = 0; i < emitter.unitKeys.length; i++) {
    const unit = emitter.unitOf[i];
    const index = emitter.unitIndex[unit];
    const start = emitter.unitStart[index];
    const length = emitter.unitEnd[index] - start;
    entries.text(emitter.unitKeys[i]);
    entries.byte(1);
    const numbers = emitter.unitNumbers;
    for (let j = 0; j < 4; j++) {
      if (j > 0) {
        entries.byte(0x2c);
      }

      entries.int(numbers[unit * 4 + j]);
    }
    entries.byte(1);
    entries.int(emitter.unitHigh[unit]);
    entries.byte(0x2c);
    entries.int(emitter.unitReach[unit]);
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

let unitLimits = new Float64Array(2);

/**
 * A SWF whose blocks and units actionsHeldEmitEachBytes and
 * actionsHeldUnitBytes compile, held from one call to the next: a block or
 * a unit is small, and copying the SWF in for each would cost more than
 * compiling it.
 */
@final
class HeldSwf {
  emitter: ModuleEmitter = new ModuleEmitter();

  constructor(
    public swf: Uint8Array,
    public offsets: Int32Array,
    public lengths: Int32Array,
  ) {}
}

/** The SWFs held, by the handle the caller gave each; it lets them go. */
const held = new Map<i32, HeldSwf>();

/**
 * Hold `swf`, its blocks those of the ranges given, by `handle`, for
 * actionsHeldEmitEachBytes and actionsHeldUnitBytes.
 */
export function actionsHold(
  handle: i32,
  swf: Uint8Array,
  offsets: Int32Array,
  lengths: Int32Array,
): void {
  held.set(handle, new HeldSwf(swf, offsets, lengths));
}

/** Let the SWF held by `handle` go, if one is. */
export function actionsRelease(handle: i32): void {
  if (held.has(handle)) {
    held.delete(handle);
  }
}

/** How many SWFs are held. */
export function actionsHeldCount(): i32 {
  return held.size;
}

/** actionsUnitBytes of the SWF held by `handle`; nothing if none is. */
export function actionsHeldUnitBytes(
  handle: i32,
  version: i32,
  at: i32,
  end: i32,
  bound: i32,
  five: bool,
): usize {
  if (!held.has(handle)) {
    return handOut(null);
  }

  const h = held.get(handle);
  return unitBytes(h.emitter, h.swf, h.offsets, h.lengths, version, at, end, bound, five);
}

/**
 * A unit of the SWF compiled alone, as V.far asks for it when control first
 * reaches it, byte for byte its entry in the module's units, as UTF-8
 * handed out where it is (handOut); its high and reach, as the module's
 * units give them, after in actionsUnitLimits.
 */
export function actionsUnitBytes(
  swf: Uint8Array,
  offsets: Int32Array,
  lengths: Int32Array,
  version: i32,
  at: i32,
  end: i32,
  bound: i32,
  five: bool,
): usize {
  return unitBytes(new ModuleEmitter(), swf, offsets, lengths, version, at, end, bound, five);
}

function unitBytes(
  emitter: ModuleEmitter,
  swf: Uint8Array,
  offsets: Int32Array,
  lengths: Int32Array,
  version: i32,
  at: i32,
  end: i32,
  bound: i32,
  five: bool,
): usize {
  emitter.unitAlone(swf, offsets, lengths, version, at, end, bound, five);
  const limits = new Float64Array(2);
  limits[0] = <f64>emitter.blocks.unitHigh;
  limits[1] = <f64>emitter.blocks.unitReach;
  unitLimits = limits;
  return handOut(emitter.out);
}

/** The high and reach of the unit actionsUnitBytes compiled last. */
export function actionsUnitLimits(): Float64Array {
  return unitLimits;
}

/**
 * Blocks of the SWF compiled alone, as the JIT may compile each when it
 * first runs: `blocks` are their indices, comma-separated, in the order to
 * compile them; `reuse` compiles them all with one emitter, else each with
 * a new one. Written as actionsModuleEntries writes them; an index with no
 * block names nothing.
 */
export function actionsEmitEach(
  swf: Uint8Array,
  offsets: Int32Array,
  lengths: Int32Array,
  version: i32,
  blocks: string,
  reuse: bool,
): string {
  const entries = emitEach(swf, offsets, lengths, version, blocks, reuse);
  return String.UTF8.decodeUnsafe(changetype<usize>(entries.bytes), entries.length);
}

/** The same entries as UTF-8, handed out where they are (handOut), avoiding the bindings' per-character string lifting. */
export function actionsEmitEachBytes(
  swf: Uint8Array,
  offsets: Int32Array,
  lengths: Int32Array,
  version: i32,
  blocks: string,
  reuse: bool,
): usize {
  return handOut(emitEach(swf, offsets, lengths, version, blocks, reuse));
}

/**
 * actionsEmitEachBytes of the SWF held by `handle` (actionsHold), which a
 * block needs whole for its backward jumps: copied in once, not for each
 * block the JIT compiles. Nothing if none is held.
 */
export function actionsHeldEmitEachBytes(handle: i32, version: i32, blocks: string): usize {
  if (!held.has(handle)) {
    return handOut(null);
  }

  const h = held.get(handle);
  return handOut(emitEach(h.swf, h.offsets, h.lengths, version, blocks, true));
}

function emitEach(
  swf: Uint8Array,
  offsets: Int32Array,
  lengths: Int32Array,
  version: i32,
  blocks: string,
  reuse: bool,
): Output {
  const count = min(offsets.length, lengths.length);
  const entries = new Output();
  let emitter = new ModuleEmitter();
  const list = blocks.split(",");
  for (let i = 0; i < list.length; i++) {
    if (list[i].length === 0) {
      continue;
    }

    const k = i32.parse(list[i]);
    if (k < 0 || k >= count) {
      continue;
    }

    if (!reuse) {
      emitter = new ModuleEmitter();
    }

    const out = emitter.out;
    out.reset();
    emitter.blocks.version = version;
    emitter.blocks.block(swf, offsets[k], lengths[k]);
    emitter.blocks.units.length = 0;
    entries.uint(k);
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

  return entries;
}
