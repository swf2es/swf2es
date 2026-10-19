// The AVM1 compiler as codegen.wasm exports it, and as the test build does
// too: a SWF's action blocks, given as ranges of its bytes in the order
// format's readActions lists them, compiled to one module, and each block
// alone, as its entry in the module (the JIT/AOT invariant of
// docs/architecture.md). Nothing is kept from one SWF to the next but
// the emitter's buffers.
import { Output } from "../output";
import { ModuleEmitter } from "./emit/module";

/** Keep entry text without retaining the compiler's reusable analysis storage. */
@final
class WrittenActions {
  constructor(
    public out: Output,
    public entryStart: u32[],
    public entryEnd: u32[],
  ) {}
}

let written: WrittenActions | null = null;

/**
 * The ES module of a SWF of version `version` whose blocks are
 * `lengths[k]` bytes from `offsets[k]` in `swf`, its decompressed bytes, as
 * UTF-8; with `keep`, its entries for actionsModuleEntries.
 */
export function actionsModuleBytes(
  swf: Uint8Array,
  offsets: Int32Array,
  lengths: Int32Array,
  version: i32,
  keep: bool = false,
): Uint8Array {
  written = null;
  const emitter = new ModuleEmitter();
  emitter.module(swf, offsets, lengths, version);
  if (keep) {
    written = new WrittenActions(emitter.out, emitter.entryStart, emitter.entryEnd);
  }

  const out = emitter.out;
  const bytes = new Uint8Array(out.length);
  memory.copy(bytes.dataStart, changetype<usize>(out.bytes), out.length);
  return bytes;
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

  return String.UTF8.decodeUnsafe(changetype<usize>(entries.bytes), entries.length);
}
