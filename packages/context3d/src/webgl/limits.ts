/** Per-context resource budgets; byte counts cover buffer storage, texture mip
 * chains and texture-target attachments, not physical driver VRAM. */
export interface WebGLContext3DLimits {
  maxBuffers: number;
  maxPrograms: number;
  maxTextures: number;
  maxBufferBytes: number;
  maxTextureBytes: number;
  maxTargetDepthBytes: number;
  maxTargetColorBytes: number;
}

const DEFAULT_LIMITS: WebGLContext3DLimits = {
  maxBuffers: 128,
  maxPrograms: 128,
  maxTextures: 128,
  maxBufferBytes: 64 * 1024 * 1024,
  maxTextureBytes: 64 * 1024 * 1024,
  maxTargetDepthBytes: 64 * 1024 * 1024,
  maxTargetColorBytes: 64 * 1024 * 1024,
};
const LIMIT_NAMES = Object.keys(DEFAULT_LIMITS) as (keyof WebGLContext3DLimits)[];

export function resourceLimits(
  overrides: Partial<WebGLContext3DLimits>,
): Readonly<WebGLContext3DLimits> {
  const limits = { ...DEFAULT_LIMITS };
  for (let i = 0; i < LIMIT_NAMES.length; i++) {
    const name = LIMIT_NAMES[i];
    const value = overrides[name];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`Context3D resource limit ${name} must be a nonnegative safe integer`);
      }

      limits[name] = value;
    }
  }

  return Object.freeze(limits);
}
