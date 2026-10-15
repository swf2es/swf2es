// A SWF's AVM1 blocks as one ES module (docs/avm1.md, "Compiling"):
//
//   export default function (rt) {
//   const V = rt.version(6);
//   return [
//   [function (cx) { ... }, function (cx, st) { ... }],
//   ...
//   ];
//   }
//
// an entry per block, in the order format's readActions lists them, each
// the array of its regions' functions. The SWF's version picks the
// operations, `V`, once for the module, so the code never tests it.

import { Output } from "../../output";
import { BlockEmitter } from "./block";

@final
export class ModuleEmitter {
  out: Output;
  blocks: BlockEmitter;
  /** Where each block's entry starts and ends in `out`. */
  entryStart: u32[] = [];
  entryEnd: u32[] = [];

  constructor() {
    const out = new Output();
    this.out = out;
    this.blocks = new BlockEmitter(out);
  }

  /**
   * The module of the blocks `lengths[k]` bytes from `offsets[k]` in `swf`,
   * a block of `version`; a range not within the SWF is an empty block.
   */
  module(swf: Uint8Array, offsets: Int32Array, lengths: Int32Array, version: i32): void {
    const out = this.out;
    out.reset();
    this.entryStart.length = 0;
    this.entryEnd.length = 0;
    this.blocks.version = version;
    out.text("export default function (rt) {\nconst V = rt.version(");
    out.int(version);
    out.text(");\nreturn [\n");
    const count = min(offsets.length, lengths.length);
    for (let k = 0; k < count; k++) {
      this.entryStart.push(out.length);
      this.blocks.block(blockOf(swf, offsets[k], lengths[k]));
      this.entryEnd.push(out.length);
      out.text(",\n");
    }

    out.text("];\n}\n");
  }
}

/** The bytes of a block, empty where they are not all in the SWF's. */
export function blockOf(swf: Uint8Array, offset: i32, length: i32): Uint8Array {
  if (offset < 0 || length < 0 || <i64>offset + <i64>length > <i64>swf.length) {
    return new Uint8Array(0);
  }

  return swf.subarray(offset, offset + length);
}
