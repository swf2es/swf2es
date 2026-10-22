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
// operations, `V`, once for the module, so the code never tests it; a
// SWF 4's module has SWF 5's too, `V5`, which its functions run with.
//
// Where blocks go on in units (flow/regions.ts), the module exports them
// too: every unit V.far may ask for as control goes on from the blocks.
// V.far asks first for the unit of a region whose end and bytes' end are
// the first bound of a block past the offset (units.ts), keyed by its
// offset and SWF 5 flag, with how far a region's end and bytes' end must
// reach for it to run for that region (BlockEmitter.unit), -1 for only
// its own; where it does not, for the region's own, keyed by its offset,
// end, bytes' end and SWF 5 flag; a first choice only its own region
// could run is left out. Units whose code is the same are written once.
// The default export then gives the runtime the units as it makes the
// blocks:
//
//   export default function (rt) {
//   const V = rt.version(6);
//   const b = [
//   ...
//   ];
//   rt.adoptUnits(b, units(rt));
//   return b;
//   }
//   export function units(rt) {
//   const V = rt.version(6);
//   const u = [
//   [function (cx) { ... }],
//   ];
//   return {
//   "120,0": [u[0], 160, 162],
//   "160,180,4096,0": [u[0], -1, -1],
//   };
//   }

import { Output } from "../../output";
import { BlockEmitter } from "./block";
import { segmentEnd, unitHigh } from "./units";

@final
export class ModuleEmitter {
  out: Output;
  blocks: BlockEmitter;
  /** Where each block's entry starts and ends in `out`. */
  entryStart: u32[] = [];
  entryEnd: u32[] = [];
  /** The units' keys, and the unit of each, by its place in the lists below. */
  unitKeys: string[] = [];
  unitOf: i32[] = [];
  /**
   * Per unit compiled: what it was compiled for, four numbers each as
   * V.far's, the index of its code in `out`'s list of units, its high and
   * reach.
   */
  unitNumbers: i32[] = [];
  unitIndex: i32[] = [];
  unitHigh: i64[] = [];
  unitReach: i64[] = [];
  /** Where each distinct unit's code starts and ends in `out`. */
  unitStart: u32[] = [];
  unitEnd: u32[] = [];

  // Per unit, by its place in unitKeys, where control goes on from it: the
  // offsets its own code returns, `exits[exitFrom[i]]` up to `exitFrom[i + 1]`,
  // and its V.far calls, four numbers each, likewise in `calls`.
  private exitFrom: i32[] = [];
  private callFrom: i32[] = [];
  private exits: i32[] = [];
  private calls: i32[] = [];
  private work: i32[] = [];
  // The code of the unit compiled last, and whether it was the first with it.
  private lastText: string = "";
  private lastAdded: bool = false;

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
    this.unitKeys.length = 0;
    this.unitOf.length = 0;
    this.unitNumbers.length = 0;
    this.unitIndex.length = 0;
    this.unitHigh.length = 0;
    this.unitReach.length = 0;
    this.unitStart.length = 0;
    this.unitEnd.length = 0;
    this.exitFrom.length = 0;
    this.callFrom.length = 0;
    this.exits.length = 0;
    this.calls.length = 0;
    const blocks = this.blocks;
    blocks.version = version;
    blocks.units.length = 0;
    blocks.exits.length = 0;
    this.prologue("export default function (rt) {\n", version);
    const opening = out.length;
    out.text("return [\n");
    const count = min(offsets.length, lengths.length);
    for (let k = 0; k < count; k++) {
      this.entryStart.push(out.length);
      blocks.block(swf, offsets[k], lengths[k]);
      this.entryEnd.push(out.length);
      out.text(",\n");
    }

    if (blocks.units.length === 0) {
      out.text("];\n}\n");
      return;
    }

    // The blocks give the runtime the module's units as they are made, so V.far finds them.
    out.text("];\nrt.adoptUnits(b, units(rt));\nreturn b;\n}\n");
    out.insert(opening, "const b = ");
    out.remove(opening + 10, 7);
    for (let k = 0; k < this.entryStart.length; k++) {
      this.entryStart[k] += 3;
      this.entryEnd[k] += 3;
    }

    this.prologue("export function units(rt) {\n", version);
    out.text("const u = [\n");
    this.unitsOf(swf, offsets, lengths);
    out.text("];\nreturn {\n");
    for (let i = 0; i < this.unitKeys.length; i++) {
      const unit = this.unitOf[i];
      out.byte(0x22);
      out.text(this.unitKeys[i]);
      out.text('": [u[');
      out.uint(this.unitIndex[unit]);
      out.text("], ");
      out.int(this.unitHigh[unit]);
      out.text(", ");
      out.int(this.unitReach[unit]);
      out.text("],\n");
    }

    out.text("};\n}\n");
  }

  /**
   * Every unit V.far may ask for, as it asks: control going on at an
   * offset of a region, from a block's code or a unit's, in the order the
   * blocks and units found it.
   */
  private unitsOf(swf: Uint8Array, offsets: Int32Array, lengths: Int32Array): void {
    const blocks = this.blocks;
    const size = swf.length;
    const compiled = new Map<string, i32>();
    const asked = new Map<string, bool>();
    const listed = new Map<string, bool>();
    const texts = new Map<string, i32>();
    const work = this.work;
    work.length = 0;
    for (let i = 0; i < blocks.units.length; i++) {
      work.push(blocks.units[i]);
    }

    for (let i = 0; i + 3 < work.length; i += 4) {
      const at = work[i];
      const end = work[i + 1];
      const bound = work[i + 2];
      const five = work[i + 3];
      const key = unitKey(at, end, bound, five);
      if (asked.has(key)) {
        continue;
      }

      asked.set(key, true);
      // The unit of a region and bytes that end with the stretch between blocks bounds `at` is
      // in, if it runs for this region too, else the region's own.
      const first = segmentEnd(offsets, lengths, size, at);
      let unit = this.unit(swf, offsets, lengths, at, first, first, five, compiled, texts, false);
      const high = this.unitHigh[unit];
      if (high >= 0) {
        this.list(`${at},${five}`, unit, listed);
      } else if (end !== first || bound !== first) {
        // A region's own alone, and not this region's: V.far never runs it.
        this.drop(unit, texts);
      }

      if (high < 0 || high > <i64>end || this.unitReach[unit] > <i64>bound) {
        unit = this.unit(swf, offsets, lengths, at, end, bound, five, compiled, texts, true);
        this.list(key, unit, listed);
      }

      const exits = this.exits;
      const exitTo = unit + 1 < this.exitFrom.length ? this.exitFrom[unit + 1] : exits.length;
      for (let j = this.exitFrom[unit]; j < exitTo; j++) {
        if (exits[j] < end) {
          work.push(exits[j]);
          work.push(end);
          work.push(bound);
          work.push(five);
        }
      }

      const calls = this.calls;
      const callTo = unit + 1 < this.callFrom.length ? this.callFrom[unit + 1] : calls.length;
      for (let j = this.callFrom[unit]; j < callTo; j++) {
        work.push(calls[j]);
      }
    }
  }

  /**
   * The code of `unit`, just compiled, out of the module's units where it
   * was the first with that code: no key names it.
   */
  private drop(unit: i32, texts: Map<string, i32>): void {
    if (!this.lastAdded) {
      return;
    }

    texts.delete(this.lastText);
    this.unitEnd.pop();
    this.out.length = this.unitStart.pop();
    this.unitIndex[unit] = -1;
  }

  /** `unit` in the module's units by `key`, once. */
  private list(key: string, unit: i32, listed: Map<string, bool>): void {
    if (listed.has(key)) {
      return;
    }

    listed.set(key, true);
    this.unitKeys.push(key);
    this.unitOf.push(unit);
  }

  /**
   * The unit of these numbers, compiled once: its place in unitIndex; its
   * code written again if dropped where it `runs`.
   */
  private unit(
    swf: Uint8Array,
    offsets: Int32Array,
    lengths: Int32Array,
    at: i32,
    end: i32,
    bound: i32,
    five: i32,
    compiled: Map<string, i32>,
    texts: Map<string, i32>,
    runs: bool,
  ): i32 {
    const key = unitKey(at, end, bound, five);
    // One whose code was dropped is written again where it is to run.
    this.lastAdded = false;
    if (compiled.has(key) && (this.unitIndex[compiled.get(key)] >= 0 || !runs)) {
      return compiled.get(key);
    }

    const out = this.out;
    const blocks = this.blocks;
    const unit = this.unitHigh.length;
    compiled.set(key, unit);
    const numbers = this.unitNumbers;
    numbers.push(at);
    numbers.push(end);
    numbers.push(bound);
    numbers.push(five);
    const start = out.length;
    blocks.exits.length = 0;
    blocks.units.length = 0;
    this.unitCode(swf, offsets, lengths, at, end, bound, five !== 0);
    this.unitHigh.push(blocks.unitHigh);
    this.unitReach.push(blocks.unitReach);
    this.exitFrom.push(this.exits.length);
    for (let j = 0; j < blocks.exits.length; j++) {
      this.exits.push(blocks.exits[j]);
    }

    this.callFrom.push(this.calls.length);
    for (let j = 0; j < blocks.units.length; j++) {
      this.calls.push(blocks.units[j]);
    }

    const text = String.UTF8.decodeUnsafe(changetype<usize>(out.bytes) + start, out.length - start);
    this.lastText = text;
    this.lastAdded = !texts.has(text);
    if (!this.lastAdded) {
      out.length = start;
      this.unitIndex.push(texts.get(text));
      return unit;
    }

    const index = this.unitStart.length;
    texts.set(text, index);
    this.unitIndex.push(index);
    this.unitStart.push(start);
    this.unitEnd.push(out.length);
    out.text(",\n");
    return unit;
  }

  /**
   * The unit V.far runs for control at `at` in `swf` (BlockEmitter.unit),
   * as the module writes it, with its high and reach in `blocks`.
   */
  unitAlone(
    swf: Uint8Array,
    offsets: Int32Array,
    lengths: Int32Array,
    version: i32,
    at: i32,
    end: i32,
    bound: i32,
    five: bool,
  ): void {
    this.out.reset();
    this.blocks.version = version;
    this.unitCode(swf, offsets, lengths, at, end, bound, five);
    this.blocks.units.length = 0;
    this.blocks.exits.length = 0;
  }

  /** One that no code can ask for, its offset not before its region's end, returns at once. */
  private unitCode(
    swf: Uint8Array,
    offsets: Int32Array,
    lengths: Int32Array,
    at: i32,
    end: i32,
    bound: i32,
    five: bool,
  ): void {
    const blocks = this.blocks;
    if (at < 0 || at >= end || end > bound || bound > swf.length) {
      this.out.text("[function (cx) {\nreturn -1;\n}]");
      blocks.unitHigh = -1;
      blocks.unitReach = -1;
      return;
    }

    blocks.unit(swf, at, end, bound, five, unitHigh(offsets, lengths, swf.length, at, end));
  }

  private prologue(opening: string, version: i32): void {
    const out = this.out;
    out.text(opening);
    out.text("const V = rt.version(");
    out.int(version);
    // A SWF 4's functions run as a SWF 5's, as Flash runs them (block.ts).
    out.text(version < 5 ? ");\nconst V5 = rt.version(5);\n" : ");\n");
  }
}

function unitKey(at: i32, end: i32, bound: i32, five: i32): string {
  return `${at},${end},${bound},${five}`;
}
