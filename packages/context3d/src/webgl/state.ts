import type { CompareMode, StencilAction } from "../backend.js";

export const DEPTH_FUNCTIONS = {
  always: "ALWAYS",
  never: "NEVER",
  less: "LESS",
  lessEqual: "LEQUAL",
  equal: "EQUAL",
  notEqual: "NOTEQUAL",
  greaterEqual: "GEQUAL",
  greater: "GREATER",
} as const;

export const BLEND_FUNCTIONS = {
  zero: "ZERO",
  one: "ONE",
  sourceColor: "SRC_COLOR",
  oneMinusSourceColor: "ONE_MINUS_SRC_COLOR",
  sourceAlpha: "SRC_ALPHA",
  oneMinusSourceAlpha: "ONE_MINUS_SRC_ALPHA",
  destinationColor: "DST_COLOR",
  oneMinusDestinationColor: "ONE_MINUS_DST_COLOR",
  destinationAlpha: "DST_ALPHA",
  oneMinusDestinationAlpha: "ONE_MINUS_DST_ALPHA",
} as const;

export const STENCIL_FUNCTIONS = {
  keep: "KEEP",
  zero: "ZERO",
  set: "REPLACE",
  incrementSaturate: "INCR",
  decrementSaturate: "DECR",
  invert: "INVERT",
  incrementWrap: "INCR_WRAP",
  decrementWrap: "DECR_WRAP",
} as const;

export class StencilState {
  compare: CompareMode = "always";
  pass: StencilAction = "keep";
  depthFail: StencilAction = "keep";
  stencilFail: StencilAction = "keep";

  get active(): boolean {
    return (
      this.compare !== "always" ||
      this.pass !== "keep" ||
      this.depthFail !== "keep" ||
      this.stencilFail !== "keep"
    );
  }
}

export function range(start: number, count: number, length: number): void {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(count) ||
    start < 0 ||
    count < 0 ||
    start > length - count
  ) {
    throw new Error("Context3D experiment: range outside resource");
  }
}
