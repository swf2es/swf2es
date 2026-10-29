// Colour transforms as Flash composes them (docs/architecture.md, "Colour
// transforms"): offsets in colour units, 0 to 255, applied after the
// multipliers, the child's transform before its parent's.
import type { ColorTransform } from "@swf2es/format";

/** The colour transform that changes nothing: an object without one draws as with this. */
export const IDENTITY_COLOR: ColorTransform = {
  rMul: 1,
  gMul: 1,
  bMul: 1,
  aMul: 1,
  rAdd: 0,
  gAdd: 0,
  bAdd: 0,
  aAdd: 0,
};

/** What a child draws, seen through its parent: `child` first, then `parent`. */
export function concatColor(parent: ColorTransform, child: ColorTransform): ColorTransform {
  return concatColorInto({ ...IDENTITY_COLOR }, parent, child);
}

/** `parent` and `child` concatenated, as concatColor does, into `out`, which is given back. */
export function concatColorInto(
  out: ColorTransform,
  parent: ColorTransform,
  child: ColorTransform,
): ColorTransform {
  out.rMul = child.rMul * parent.rMul;
  out.gMul = child.gMul * parent.gMul;
  out.bMul = child.bMul * parent.bMul;
  out.aMul = child.aMul * parent.aMul;
  out.rAdd = child.rAdd * parent.rMul + parent.rAdd;
  out.gAdd = child.gAdd * parent.gMul + parent.gAdd;
  out.bAdd = child.bAdd * parent.bMul + parent.bAdd;
  out.aAdd = child.aAdd * parent.aMul + parent.aAdd;
  return out;
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
