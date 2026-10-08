// Colour transforms as Flash composes them (docs/architecture.md, "Colour
// transforms"): offsets in colour units, 0 to 255, applied after the
// multipliers, the child's transform before its parent's.
import type { ColorTransform } from "@swf2es/format";

/** What a child draws, seen through its parent: `child` first, then `parent`. */
export function concatColor(parent: ColorTransform, child: ColorTransform): ColorTransform {
  return {
    rMul: child.rMul * parent.rMul,
    gMul: child.gMul * parent.gMul,
    bMul: child.bMul * parent.bMul,
    aMul: child.aMul * parent.aMul,
    rAdd: child.rAdd * parent.rMul + parent.rAdd,
    gAdd: child.gAdd * parent.gMul + parent.gAdd,
    bAdd: child.bAdd * parent.bMul + parent.bAdd,
    aAdd: child.aAdd * parent.aMul + parent.aAdd,
  };
}

/** Whether `ct` only multiplies, each channel by 0 to 1, which Pixi's tint and alpha draw. */
export function multipliesOnly(ct: ColorTransform): boolean {
  return (
    ct.rAdd === 0 &&
    ct.gAdd === 0 &&
    ct.bAdd === 0 &&
    ct.aAdd === 0 &&
    ct.rMul >= 0 &&
    ct.rMul <= 1 &&
    ct.gMul >= 0 &&
    ct.gMul <= 1 &&
    ct.bMul >= 0 &&
    ct.bMul <= 1 &&
    ct.aMul >= 0 &&
    ct.aMul <= 1
  );
}

export function sameColor(a: ColorTransform | null, b: ColorTransform | null): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.rMul === b.rMul &&
      a.gMul === b.gMul &&
      a.bMul === b.bMul &&
      a.aMul === b.aMul &&
      a.rAdd === b.rAdd &&
      a.gAdd === b.gAdd &&
      a.bAdd === b.bAdd &&
      a.aAdd === b.aAdd)
  );
}
