/** Backend failures stay independent of the API that exposes them to content. */
export type Context3DErrorReason =
  | "disposed"
  | "backBuffer"
  | "limit"
  | "bufferAllocation"
  | "textureAllocation"
  | "nativeShader"
  | "program"
  | "indexBuffer"
  | "indexData"
  | "vertexBinding"
  | "vertexStream"
  | "vertexData"
  | "drawRange"
  | "triangleCount"
  | "textureSize"
  | "compressedSize"
  | "textureShape"
  | "texturePowerOfTwo"
  | "textureUpload"
  | "range"
  | "operation"
  | "unsupported"
  | "agalLength"
  | "agalMagic"
  | "agalVersion"
  | "agalStageMarker"
  | "agalVertexStage"
  | "agalFragmentStage"
  | "agalStage"
  | "agalTokens"
  | "agalOpcode"
  | "agalUnusedSource"
  | "agalAttributeStage"
  | "agalAttributeWrite"
  | "agalAttributeIndex"
  | "agalConstantWrite"
  | "agalConstantIndex"
  | "agalTemporaryIndex"
  | "agalTemporaryRead"
  | "agalTemporaryComponent"
  | "agalOutputRead"
  | "agalOutputIndex"
  | "agalVertexOutput"
  | "agalFragmentOutput"
  | "agalColorMask"
  | "agalVaryingIndex"
  | "agalVaryingRead"
  | "agalVaryingWrite"
  | "agalVaryingMissing"
  | "agalVaryingPartial"
  | "agalRegister"
  | "agalIndirect"
  | "agalSourceEncoding"
  | "agalDiscard"
  | "agalMask"
  | "agalReserved"
  | "agalSampler"
  | "agalProfileVersion"
  | "agalOpcodeRange"
  | "agalOpcodeVersion"
  | "agalFragmentOnly"
  | "agalSamplerStage"
  | "agalElse"
  | "agalEndIf"
  | "agalEmptyBranch"
  | "agalConditionDestination"
  | "agalScalar"
  | "agalNesting"
  | "agalConditionOutput"
  | "agalConditionTexture"
  | "agalDepthStage"
  | "agalDepthIndex"
  | "agalDepthMask"
  | "agalInstanceStage"
  | "agalOutputTwice"
  | "agalOutputSlots"
  | "agalConditionDerivative"
  | "agalConstants"
  | "agalNativeLength"
  | "agalSamplerIndex"
  | "agalSamplerDimension"
  | "agalSamplerMip"
  | "agalSamplerFilter";

/** Which of the backend's errors an error is, under its brand. */
export type Context3DErrorKind =
  | "context3d"
  | "vertexOffset"
  | "scissorBounds"
  | "samplerBias"
  | "textureBinding";

/**
 * The backend's errors are told by a brand under a symbol of the global
 * registry, not by instanceof: a page may give the player a backend from
 * its own copy of this package, as the site's bundle and a page beside the
 * browser build do, whose classes are not the player's.
 */
const BRAND = Symbol.for("swf2es.context3d.error");

/** Mark `type`'s errors as `kind`'s, on its prototype. */
export function brand(type: abstract new (...args: never[]) => Error, kind: Context3DErrorKind) {
  Object.defineProperty(type.prototype, BRAND, { value: kind });
}

/** The kind of the backend's error `error` is, of any copy of this package, or null. */
export function context3DErrorKind(error: unknown): Context3DErrorKind | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  return (error as { [BRAND]?: Context3DErrorKind })[BRAND] ?? null;
}

export class Context3DError extends Error {
  readonly reason: Context3DErrorReason;

  constructor(reason: Context3DErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

brand(Context3DError, "context3d");

export const isContext3DError = (error: unknown): error is Context3DError =>
  context3DErrorKind(error) === "context3d";
