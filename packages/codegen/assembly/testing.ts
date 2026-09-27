// Test-only entry point: exposes the reader to node tests without adding
// exports to codegen.wasm.
import { PADDING, Reader } from "./reader";

export const U8: u8 = 0;
export const U16: u8 = 1;
export const S24: u8 = 2;
export const U30: u8 = 3;
export const U32: u8 = 4;
export const S32: u8 = 5;
export const D64: u8 = 6;
export const UTF8: u8 = 7;

/**
 * Read `kinds` in order from `input` and return the values, then the final
 * position and 1 if the reader failed. UTF8 yields the string's byte length
 * and skips its bytes.
 */
export function readAll(input: Uint8Array, kinds: Uint8Array): Float64Array {
  const padded = new StaticArray<u8>(input.length + PADDING);
  const start = changetype<usize>(padded);
  memory.copy(start, input.dataStart, input.length);

  const r = new Reader(start, start + input.length);
  const values = new Float64Array(kinds.length + 2);
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i];
    let value: f64 = 0;
    if (kind === U8) {
      value = r.u8();
    } else if (kind === U16) {
      value = r.u16();
    } else if (kind === S24) {
      value = r.s24();
    } else if (kind === U30) {
      value = r.u30();
    } else if (kind === U32) {
      value = r.u32();
    } else if (kind === S32) {
      value = r.s32();
    } else if (kind === D64) {
      value = r.d64();
    } else if (kind === UTF8) {
      const length = r.utf8Length();
      r.skip(length);
      value = length;
    }
    values[i] = value;
  }

  values[kinds.length] = <f64>(r.pos - start);
  values[kinds.length + 1] = r.failed ? 1 : 0;
  return values;
}
