// Domain memory, as avmplus' MOPS: where li8 and the other opcodes can
// read and write the runtime's view in place, at an int or uint address
// whose bytes are in range, and the DataView method each one uses.
import * as ops from "../abc/opcodes";
import { BUILTIN_Int, BUILTIN_Uint } from "../link/traits";
import { MethodEmitter } from "./method";

/** Whether register r is a domain memory address the emitter can use as it is: an int or uint. */
export function isAddress(em: MethodEmitter, r: i32): bool {
  const bt = em.builtinOf(r);
  return bt === BUILTIN_Int || bt === BUILTIN_Uint;
}

/** `(a >>> 0) <= rt.memoryLength - size`: whether op's bytes at address register a are all in the domain memory. */
export function inRange(em: MethodEmitter, a: i32, op: u16): void {
  em.out.text("(");
  em.reg(a);
  em.out.text(" >>> 0) <= rt.memoryLength - ");
  em.out.uint(memorySize(op));
}

/** How many bytes op loads or stores. */
function memorySize(op: u16): u32 {
  switch (op) {
    case ops.OP_li8:
    case ops.OP_si8:
      return 1;
    case ops.OP_li16:
    case ops.OP_si16:
      return 2;
    case ops.OP_lf64:
    case ops.OP_sf64:
      return 8;
    default:
      return 4;
  }
}

/** The DataView method that loads or stores as op does, little-endian. */
export function viewMethod(op: u16): string {
  switch (op) {
    case ops.OP_li8:
      return "getUint8";
    case ops.OP_li16:
      return "getUint16";
    case ops.OP_li32:
      return "getInt32";
    case ops.OP_lf32:
      return "getFloat32";
    case ops.OP_lf64:
      return "getFloat64";
    case ops.OP_si8:
      return "setUint8";
    case ops.OP_si16:
      return "setUint16";
    case ops.OP_si32:
      return "setInt32";
    case ops.OP_sf32:
      return "setFloat32";
    default:
      return "setFloat64";
  }
}
