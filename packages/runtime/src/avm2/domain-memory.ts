// What generated code loads and stores domain memory in place through, at
// an int or uint address: a DataView, whose own range check rejects the
// addresses avmplus' MOPS reject, with a RangeError of its own. The method
// that made the access turns it into avmplus' RangeError 1506
// (Runtime.memoryError), before any caller or handler sees it.
import type { Runtime } from "./runtime.js";

/**
 * The messages of the RangeErrors a DataView throws for an offset out of
 * its range, as this engine words them: below 0, past the end, and with
 * too few bytes left, for a load and a store.
 */
const viewRangeMessages: ReadonlySet<string> = (() => {
  const messages = new Set<string>();
  const view = new DataView(new ArrayBuffer(4));
  const probes = [
    () => view.getUint8(-1),
    () => view.getUint8(4),
    () => view.getInt32(1, true),
    () => view.getFloat64(0, true),
    () => view.setUint8(-1, 0),
    () => view.setUint16(3, 0, true),
    () => view.setFloat64(0, 0, true),
    () => view.getUint8(0xffffffff),
  ];
  for (let i = 0; i < probes.length; i++) {
    try {
      probes[i]();
    } catch (e) {
      if (e instanceof RangeError) {
        messages.add(e.message);
      }
    }
  }

  return messages;
})();

/** Whether `e` is the RangeError a DataView throws for an offset out of its range. */
export function isViewRangeError(e: unknown): boolean {
  return e instanceof RangeError && viewRangeMessages.has(e.message);
}

/**
 * Domain memory another worker shares, as generated code reaches it: each
 * access through the runtime's li8 and the others, which read the length
 * again, as that worker may have grown it, before they reject an address.
 */
export class SharedMemoryView {
  private readonly rt: Runtime;

  constructor(rt: Runtime) {
    this.rt = rt;
  }

  getUint8(at: number): number {
    return this.rt.li8(at);
  }

  getUint16(at: number, _littleEndian: boolean): number {
    return this.rt.li16(at);
  }

  getInt32(at: number, _littleEndian: boolean): number {
    return this.rt.li32(at);
  }

  getFloat32(at: number, _littleEndian: boolean): number {
    return this.rt.lf32(at);
  }

  getFloat64(at: number, _littleEndian: boolean): number {
    return this.rt.lf64(at);
  }

  setUint8(at: number, value: number): void {
    this.rt.si8(value, at);
  }

  setUint16(at: number, value: number, _littleEndian: boolean): void {
    this.rt.si16(value, at);
  }

  setInt32(at: number, value: number, _littleEndian: boolean): void {
    this.rt.si32(value, at);
  }

  setFloat32(at: number, value: number, _littleEndian: boolean): void {
    this.rt.sf32(value, at);
  }

  setFloat64(at: number, value: number, _littleEndian: boolean): void {
    this.rt.sf64(value, at);
  }
}
