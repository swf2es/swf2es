/** Experimental renderer contracts and AGAL v1 translation, without browser dependencies. */

export { type ProgramType, type SamplerSource, type ShaderSource, translate } from "./agal.js";
export {
  BLEND_FACTORS,
  type BlendFactor,
  type Buffer3D,
  COMPARE_MODES,
  type CompareMode,
  type Context3D,
  type Context3DLifecycle,
  CULL_FACES,
  type CullFace,
  type Program3D,
  SAMPLER_FILTERS,
  SAMPLER_MIPS,
  SAMPLER_WRAPS,
  SamplerBiasError,
  type SamplerFilter,
  type SamplerMip,
  type SamplerWrap,
  ScissorBoundsError,
  STENCIL_ACTIONS,
  type Stage3DHost,
  type StencilAction,
  TEXTURE_FORMATS,
  type Texture3D,
  TextureBindingError,
  type TextureFormat,
  VERTEX_FORMATS,
  type VertexFormat,
  VertexOffsetError,
} from "./backend.js";
export { blockBytes, decodeDxt, encodeDxt } from "./dxt.js";
export { Context3DError, type Context3DErrorReason } from "./errors.js";
