import { floatLibrary } from "./float-library.js";

// A scalar float keeps its identity when it escapes into a dynamic value.
// Its numeric payload is rounded only when a float is produced.
export class FloatValue {
  constructor(readonly value: number) {}

  valueOf(): number {
    return this.value;
  }
}

const ZERO = new FloatValue(0);
const NEGATIVE_ZERO = new FloatValue(-0);
const NAN = new FloatValue(NaN);

export function floatValue(value: number): FloatValue {
  const rounded = Math.fround(value);
  if (rounded === 0) {
    return Object.is(rounded, -0) ? NEGATIVE_ZERO : ZERO;
  }

  return Number.isNaN(rounded) ? NAN : new FloatValue(rounded);
}

/** Whether a caller already supplied the scalar float builtin. */
export function hasFloatLibrary(abcs: readonly Uint8Array[]): boolean {
  return abcs.some(
    (abc) => abc.length === floatLibrary.length && abc.every((byte, i) => byte === floatLibrary[i]),
  );
}
