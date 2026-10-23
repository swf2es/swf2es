import { Context3DError, type Context3DErrorReason } from "@swf2es/context3d";
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../scripting.js";

const ERROR_IDS: Record<Context3DErrorReason, number> = {
  disposed: 3694,
  backBuffer: 3698,
  limit: 3691,
  bufferAllocation: 3672,
  textureAllocation: 3684,
  nativeShader: 3613,
  program: 3600,
  indexBuffer: 3601,
  indexData: 3601,
  vertexBinding: 3611,
  vertexStream: 3608,
  vertexData: 3609,
  drawRange: 3603,
  triangleCount: 3602,
  textureSize: 3683,
  textureShape: 3678,
  texturePowerOfTwo: 3682,
  textureUpload: 3679,
  range: 3669,
  operation: 3699,
  unsupported: 3708,
  agalLength: 3615,
  agalMagic: 3616,
  agalVersion: 3617,
  agalStageMarker: 3618,
  agalVertexStage: 3631,
  agalFragmentStage: 3630,
  agalStage: 3619,
  agalTokens: 3629,
  agalOpcode: 3621,
  agalUnusedSource: 3636,
  agalAttributeStage: 3645,
  agalAttributeWrite: 3651,
  agalAttributeIndex: 3658,
  agalConstantWrite: 3652,
  agalConstantIndex: 3659,
  agalTemporaryIndex: 3661,
  agalTemporaryRead: 3647,
  agalTemporaryComponent: 3648,
  agalOutputRead: 3646,
  agalOutputIndex: 3660,
  agalVertexOutput: 3635,
  agalFragmentOutput: 3634,
  agalColorMask: 3701,
  agalVaryingIndex: 3657,
  agalVaryingRead: 3644,
  agalVaryingWrite: 3650,
  agalVaryingMissing: 3632,
  agalVaryingPartial: 3633,
  agalRegister: 3655,
  agalIndirect: 3639,
  agalSourceEncoding: 3643,
  agalDiscard: 3703,
  agalMask: 3653,
  agalReserved: 3654,
  agalSampler: 3668,
};

/** Only known backend failures become Flash errors; programming errors still surface. */
export function translateErrors(natives: avm2.Natives, s: Scripting): void {
  const keys = Object.keys(natives);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const native = natives[key](s.rt);
    // Fixed arguments avoid an array allocation in native draw/state calls.
    natives[key] = avm2.plain(function (
      this: avm2.Value,
      a: avm2.Value,
      b: avm2.Value,
      c: avm2.Value,
      d: avm2.Value,
      e: avm2.Value,
      f: avm2.Value,
      g: avm2.Value,
      h: avm2.Value,
    ): avm2.Value {
      try {
        return native.call(this, a, b, c, d, e, f, g, h);
      } catch (error) {
        if (error instanceof Context3DError) {
          const kind = error.reason === "drawRange" ? "RangeError" : "Error";
          throw s.rt.error(kind, ERROR_IDS[error.reason]);
        }

        throw error;
      }
    });
  }
}
