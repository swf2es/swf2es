import {
  BLEND_FACTORS,
  type BlendFactor,
  COMPARE_MODES,
  type CompareMode,
  Context3DError,
  CULL_FACES,
  type CullFace,
  compressedFormat,
  FRAGMENT_CONSTANTS,
  MOST_BACK_BUFFER,
  MOST_CUBE,
  type ProgramType,
  profileLimits,
  SAMPLER_FILTERS,
  SAMPLER_MIPS,
  SAMPLER_SLOTS,
  SAMPLER_WRAPS,
  type SamplerFilter,
  type SamplerMip,
  type SamplerWrap,
  ScissorBoundsError,
  STENCIL_ACTIONS,
  type StencilAction,
  screenPixels,
  TEXTURE_FORMATS,
  TextureBindingError,
  type TextureFormat,
  VERTEX_CONSTANTS,
  VERTEX_FORMATS,
  VERTEX_SLOTS,
  type VertexFormat,
  VertexOffsetError,
} from "@swf2es/context3d";
import { avm2 } from "@swf2es/runtime";
import type { As3 } from "../../as3/types.js";
import type { Scripting } from "../../scripting.js";
import { storeOf } from "../flash/display/BitmapData.js";

import type { AsObject, Bindings, ContextState } from "./lifecycle.js";
import { writeReadback } from "./readback.js";

/** maxBackBufferWidth and maxBackBufferHeight of a disposed context, as AIR reads them. */
const DISPOSED_MOST = 2048;

/** The SWF version from which a refused size is #3780 or #3781, not #3669. */
const SIZE_ERRORS_FROM = 30;

/**
 * A maxBackBufferWidth or maxBackBufferHeight set: AIR takes it between the back buffer's
 * size (at least 32), in stage pixels even where it is drawn at the screen's, and the GPU's
 * limit.
 */
function most(value: number, size: number, limit: number): number {
  return Math.min(limit, Math.max(32, size, value | 0));
}

export function registerContext(natives: avm2.Natives, s: Scripting, bindings: Bindings): void {
  /** Whether a buffer's usage is dynamicDraw: only it and staticDraw are, by their case. */
  const dynamicUsage = (usage: string | null): boolean => {
    switch (usage) {
      case "staticDraw":
        return false;
      case "dynamicDraw":
        return true;
      case null:
        throw s.rt.error("TypeError", 2007, "bufferUsage");
      default:
        throw s.rt.error("ArgumentError", 2008, "bufferUsage");
    }
  };
  /** AIR 51 refuses a negative streamingLevels (#2004) and one past the smallest level (#3711). */
  const streamingLevels = (levels: number, side: number): void => {
    if (levels < 0) {
      throw s.rt.error("Error", 2004);
    }
    // A side that is no power of two, which the backend refuses, has no levels to compare.
    if (side > 0 && levels > Math.floor(Math.log2(side))) {
      throw s.rt.error("ArgumentError", 3711);
    }
  };
  /**
   * How many of `count` constant registers from `first` a setter writes. Every profile takes
   * 250 vertex and 200 fragment registers, whatever its AGAL reads (Profiles.as): a first one
   * past them is #2006, and a run past their end writes those that fit (ContextArguments.as).
   */
  const within = (stage: ProgramType, first: number, count: number): number => {
    const registers = stage === "vertex" ? VERTEX_CONSTANTS : FRAGMENT_CONSTANTS;
    if (first >= registers) {
      throw s.rt.error("RangeError", 2006);
    }

    return first >= 0 && count > 0 ? Math.min(count, registers - first) : count;
  };
  /** A program type, which AIR names programType when it refuses one. */
  const programType = (type: string | null): ProgramType => {
    switch (type) {
      case "vertex":
      case "fragment":
        return type;
      case null:
        throw s.rt.error("TypeError", 2007, "programType");
      default:
        throw s.rt.error("ArgumentError", 2008, "programType");
    }
  };
  const {
    contexts,
    buffers,
    programs,
    textures,
    own,
    allocate,
    state,
    context,
    requireClear,
    buffer,
    program,
    construct,
    texture,
    request,
    dispose,
  } = bindings;
  const matrixConstants = new Float32Array(16);
  // Drawn at the screen's pixels as they change, between frames: cleared again before drawing.
  bindings.followScale((entry) => {
    const scale = s.contentsScaleFactor;
    const width = screenPixels(entry.width, scale);
    const height = screenPixels(entry.height, scale);
    if (width < 32 || height < 32 || width > entry.maxWidth || height > entry.maxHeight) {
      return;
    }

    try {
      entry.backend.configure(width, height, entry.depth, entry.aa, scale);
    } catch (error) {
      // What the GPU cannot give at the new size, it keeps at the old.
      if (!(error instanceof Context3DError)) {
        throw error;
      }

      return;
    }

    entry.cleared = 0;
  });

  /** The back buffer alone again: what setRenderToBackBuffer and present leave. */
  const resetOutputs = (entry: ContextState): void => {
    for (let i = 0; i < entry.outputs.length; i++) {
      if (entry.outputs[i]) {
        entry.backend.setColorOutput(i + 1, null);
        entry.outputs[i] = null;
      }
    }
  };

  /**
   * How many colour outputs a clear or draw writes, checked as AIR checks them: the others
   * only beside a texture target (#3728), each of its size, format, depth and antialiasing
   * (#3729).
   */
  const colorOutputs = (entry: ContextState): number => {
    let count = 1;
    for (let i = 0; i < entry.outputs.length; i++) {
      const output = entry.outputs[i];
      if (!output) {
        continue;
      }

      const target = entry.target?.value;
      if (!target) {
        throw s.rt.error("Error", 3728);
      }
      if (
        output.value.width !== target.width ||
        output.value.height !== target.height ||
        output.value.format !== target.format ||
        output.depth !== entry.targetDepth ||
        output.antiAlias !== entry.targetAntiAlias
      ) {
        throw s.rt.error("Error", 3729);
      }
      count = i + 2;
    }

    return count;
  };

  /** A texture's format: one Flash names (#2008), and in rgbaHalfFloat's case one its profile has (#3759). */
  const textureFormat = (entry: ContextState, format: string | null): TextureFormat => {
    if (format === null) {
      throw s.rt.error("TypeError", 2007, "format");
    }
    if (!TEXTURE_FORMATS.includes(format as TextureFormat)) {
      throw s.rt.error("ArgumentError", 2008, "format");
    }
    if (format === "rgbaHalfFloat" && !profileLimits(entry.profile).halfFloat) {
      throw s.rt.error("ArgumentError", 3759);
    }

    return format as TextureFormat;
  };

  class ContextNatives {
    get driverInfo(): string {
      return contexts.has(this as unknown as AsObject) ? "swf2es experimental WebGL2" : "Disposed";
    }

    get profile(): string | null {
      return contexts.get(this as unknown as AsObject)?.profile ?? null;
    }

    declare $checking: boolean;

    get enableErrorChecking(): boolean {
      return this.$checking ?? false;
    }

    set enableErrorChecking(value: boolean) {
      this.$checking = value;
    }

    get backBufferWidth(): number {
      return contexts.get(this as unknown as AsObject)?.backend.width ?? 0;
    }

    get backBufferHeight(): number {
      return contexts.get(this as unknown as AsObject)?.backend.height ?? 0;
    }

    declare $maxWidth: number | undefined;
    declare $maxHeight: number | undefined;

    get maxBackBufferWidth(): number {
      return contexts.get(this as unknown as AsObject)?.maxWidth ?? this.$maxWidth ?? DISPOSED_MOST;
    }

    set maxBackBufferWidth(value: number) {
      const entry = contexts.get(this as unknown as AsObject);
      if (entry) {
        entry.maxWidth = most(value, entry.width, MOST_BACK_BUFFER);
      } else {
        this.$maxWidth = most(value, 0, DISPOSED_MOST);
      }
    }

    get maxBackBufferHeight(): number {
      return (
        contexts.get(this as unknown as AsObject)?.maxHeight ?? this.$maxHeight ?? DISPOSED_MOST
      );
    }

    set maxBackBufferHeight(value: number) {
      const entry = contexts.get(this as unknown as AsObject);
      if (entry) {
        entry.maxHeight = most(value, entry.height, MOST_BACK_BUFFER);
      } else {
        this.$maxHeight = most(value, 0, DISPOSED_MOST);
      }
    }

    configureBackBuffer(
      width: number,
      height: number,
      aa: number,
      depth = true,
      best = false,
      _zoom = false,
    ): void {
      const entry = state(this as unknown as AsObject);
      const backend = entry.backend;
      // With best resolution AIR draws at the screen's pixels, and holds those to 32 and to
      // maxBackBufferWidth and maxBackBufferHeight: 16 by 16 is 32 by 32 at a scale of 2.
      // The browser's zoom is in contentsScaleFactor already, so the zoom flag adds nothing,
      // as it adds nothing in AIR, whose browserZoomFactor is 1.
      const scale = best ? s.contentsScaleFactor : 1;
      const drawnWidth = screenPixels(width, scale);
      const drawnHeight = screenPixels(height, scale);
      // AIR's limits are the GPU's, 16384 on a desktop one in every profile (Flash Player 32
      // and AIR 51 alike); a GPU that allows less draws the back buffer smaller and stretches
      // it (WebGLContext3D), where AIR would refuse.
      const wide = !(drawnWidth >= 32 && drawnWidth <= entry.maxWidth);
      if (wide || !(drawnHeight >= 32 && drawnHeight <= entry.maxHeight)) {
        // The back buffer it had is gone: clear refuses until another configure.
        backend.unconfigure();
        entry.width = 0;
        entry.height = 0;
        entry.best = false;
        if (s.rt.swfVersion < SIZE_ERRORS_FROM) {
          throw s.rt.error("Error", 3669);
        }

        throw wide
          ? s.rt.error("Error", 3780, 32, entry.maxWidth)
          : s.rt.error("Error", 3781, 32, entry.maxHeight);
      }

      const changed =
        drawnWidth !== backend.width ||
        drawnHeight !== backend.height ||
        depth !== entry.depth ||
        aa !== entry.aa;
      backend.configure(drawnWidth, drawnHeight, depth, aa, scale);
      if (changed) {
        entry.cleared = 0;
      }

      entry.depth = depth;
      entry.aa = aa;
      entry.width = width;
      entry.height = height;
      entry.best = best;
    }

    clear(r = 0, g = 0, b = 0, a = 1, depth = 1, stencil = 0, mask = 0xffffffff): void {
      const entry = state(this as unknown as AsObject);
      if (entry.compressedTarget) {
        throw s.rt.error("Error", 3746);
      }

      const backend = entry.backend;
      // Without error checking, as after a size refused, AIR clears nothing and says nothing.
      if (backend.width === 0) {
        if (this.$checking) {
          throw s.rt.error("Error", 3698);
        }

        return;
      }

      colorOutputs(entry);
      // AIR reads the mask's three low bits alone: 8 clears nothing, 15 clears all.
      backend.clear(r, g, b, a, depth, mask & 7, stencil);
      // Only successful AS3 clears count, not the backend's allocation-time clear.
      if (entry.target) {
        entry.target.initialized = true;
        for (let i = 0; i < entry.outputs.length; i++) {
          const output = entry.outputs[i];
          const resource = output && textures.get(output.object);
          if (resource) {
            resource.initialized = true;
          }
        }
      } else {
        entry.cleared |= mask & (entry.depth ? 7 : 1);
      }
    }

    createVertexBuffer(
      count: number,
      stride: number,
      usage: string | null = "staticDraw",
    ): AsObject {
      const dynamic = dynamicUsage(usage);
      // As AIR 51 refuses them: a negative count of values, none, and more than 64.
      if (stride < 0) {
        throw s.rt.error("Error", 2004);
      }
      if (stride === 0) {
        throw s.rt.error("ArgumentError", 3671);
      }
      if (stride > 64) {
        throw s.rt.error("ArgumentError", 3670);
      }

      const owner = this as unknown as AsObject;
      const resource = allocate(owner, () => context(owner).createBuffer(count, stride, dynamic));
      const object = construct("VertexBuffer3D", resource);
      buffers.set(
        object,
        own(object, {
          value: resource,
          owner,
          disposed: false,
          reference: new WeakRef(object),
        }),
      );

      return object;
    }

    createIndexBuffer(count: number, usage: string | null = "staticDraw"): AsObject {
      const dynamic = dynamicUsage(usage);
      const owner = this as unknown as AsObject;
      const resource = allocate(owner, () => context(owner).createBuffer(count, 0, dynamic));
      const object = construct("IndexBuffer3D", resource);
      buffers.set(
        object,
        own(object, {
          value: resource,
          owner,
          disposed: false,
          reference: new WeakRef(object),
        }),
      );

      return object;
    }

    createProgram(): AsObject {
      const owner = this as unknown as AsObject;
      const resource = allocate(owner, () => context(owner).createProgram());
      const object = construct("Program3D", resource);
      programs.set(
        object,
        own(object, {
          value: resource,
          owner,
          disposed: false,
          reference: new WeakRef(object),
        }),
      );

      return object;
    }

    createTexture(
      width: number,
      height: number,
      format: string,
      _target: boolean,
      levels = 0,
    ): AsObject {
      const entry = state(this as unknown as AsObject);
      const backend = entry.backend;
      const compressed = textureFormat(entry, format);
      const most = profileLimits(entry.profile).textureSize;
      if (width > most || height > most) {
        throw s.rt.error("ArgumentError", 3683, most);
      }
      streamingLevels(levels, Math.max(width, height));
      const value = allocate(this as unknown as AsObject, () =>
        backend.createTexture(width, height, false, compressed, levels),
      );
      const object = construct("Texture", value, "flash.display3D.textures");
      textures.set(
        object,
        own(object, {
          value,
          owner: this as unknown as AsObject,
          disposed: false,
          initialized: false,
          reference: new WeakRef(object),
        }),
      );

      return object;
    }

    createRectangleTexture(
      width: number,
      height: number,
      format: string | null,
      _target: boolean,
    ): AsObject {
      const entry = state(this as unknown as AsObject);
      const backend = entry.backend;
      // baselineConstrained has none.
      const most = profileLimits(entry.profile).rectangleSize;
      if (!most) {
        throw s.rt.error("Error", 3782);
      }
      const kind = textureFormat(entry, format);
      if (width <= 0 || height <= 0) {
        throw s.rt.error("ArgumentError", 3681);
      }
      if (width > most || height > most) {
        throw s.rt.error("ArgumentError", 3766, most);
      }
      if (compressedFormat(kind)) {
        throw s.rt.error("ArgumentError", 3762);
      }

      const value = allocate(this as unknown as AsObject, () =>
        backend.createRectangleTexture(width, height, kind),
      );
      const object = construct("RectangleTexture", value, "flash.display3D.textures");
      textures.set(
        object,
        own(object, {
          value,
          owner: this as unknown as AsObject,
          disposed: false,
          initialized: false,
          reference: new WeakRef(object),
        }),
      );

      return object;
    }

    createCubeTexture(size: number, format: string, _target: boolean, levels = 0): AsObject {
      const entry = state(this as unknown as AsObject);
      const backend = entry.backend;
      const compressed = textureFormat(entry, format);
      if (size > MOST_CUBE) {
        throw s.rt.error("ArgumentError", 3705);
      }
      streamingLevels(levels, size);
      const value = allocate(this as unknown as AsObject, () =>
        backend.createTexture(size, size, true, compressed, levels),
      );
      const object = construct("CubeTexture", value, "flash.display3D.textures");
      textures.set(
        object,
        own(object, {
          value,
          owner: this as unknown as AsObject,
          disposed: false,
          initialized: false,
          reference: new WeakRef(object),
        }),
      );

      return object;
    }

    setSamplerStateAt(
      index: number,
      wrap: string | null,
      filter: string | null,
      mip: string | null,
    ): void {
      if (wrap === null) {
        throw s.rt.error("TypeError", 2007, "wrap");
      }
      if (!SAMPLER_WRAPS.includes(wrap as SamplerWrap)) {
        throw s.rt.error("ArgumentError", 2008, "wrap");
      }
      if (filter === null) {
        throw s.rt.error("TypeError", 2007, "filter");
      }
      if (!SAMPLER_FILTERS.includes(filter as SamplerFilter)) {
        throw s.rt.error("ArgumentError", 2008, "filter");
      }
      if (mip === null) {
        throw s.rt.error("TypeError", 2007, "mipfilter");
      }
      if (!SAMPLER_MIPS.includes(mip as SamplerMip)) {
        throw s.rt.error("ArgumentError", 2008, "mipfilter");
      }
      if (index < 0 || index >= 16) {
        throw s.rt.error("RangeError", 2006);
      }

      const backend = contexts.get(this as unknown as AsObject)?.backend;
      if (backend) {
        backend.setSampler(index, wrap as SamplerWrap, filter as SamplerFilter, mip as SamplerMip);
      }
    }

    setTextureAt(index: number, object: AsObject | null): void {
      const entry = state(this as unknown as AsObject);
      if (index < 0 || index >= SAMPLER_SLOTS) {
        throw s.rt.error("RangeError", 2006);
      }
      if (object && !textures.has(object)) {
        // An AS3-created TextureBase has no native resource and leaves this slot intact.
        const previous = entry.textures[index];
        entry.backend.setTexture(index, previous ? texture(previous) : null);
        return;
      }

      entry.backend.setTexture(index, object && texture(object));
      entry.textures[index] = object;
    }

    setRenderToTexture(
      object: AsObject | null,
      depth = false,
      aa = 0,
      surface = 0,
      output = 0,
    ): void {
      if (output < 0 || output > 3) {
        throw s.rt.error("ArgumentError", 3770);
      }

      const entry = state(this as unknown as AsObject);
      if (output > 0 && profileLimits(entry.profile).colorOutputs === 1) {
        throw s.rt.error("ArgumentError", 3779);
      }
      if (object && !textures.has(object)) {
        throw s.rt.error("ArgumentError", 0);
      }

      let value = object && texture(object);
      if (value && (surface < 0 || surface >= (value.cube ? 6 : 1))) {
        throw s.rt.error("ArgumentError", value.cube ? 3772 : 3771);
      }
      if (object && textures.get(object)?.disposed) {
        value = null;
      }
      if (output > 0) {
        entry.backend.setColorOutput(output, value, surface);
        entry.outputs[output - 1] =
          value && object ? { object, value, depth, antiAlias: aa } : null;
        return;
      }

      // AIR takes a compressed texture as the target, and refuses to clear or draw into it.
      entry.compressedTarget = value !== null && compressedFormat(value.format);
      if (entry.compressedTarget) {
        value = null;
      }

      entry.backend.setRenderTarget(value, depth, surface, aa);
      entry.target = value && object ? (textures.get(object) ?? null) : null;
      entry.targetObject = value ? object : null;
      entry.targetDepth = depth;
      entry.targetAntiAlias = aa;
    }

    setRenderToBackBuffer(): void {
      const entry = state(this as unknown as AsObject);
      entry.compressedTarget = false;
      entry.backend.setRenderTarget(null);
      entry.target = null;
      entry.targetObject = null;
      resetOutputs(entry);
    }

    setProgram(object: AsObject): void {
      const entry = state(this as unknown as AsObject);
      entry.backend.setProgram(program(object));
      entry.program = object;
    }

    setVertexBufferAt(index: number, object: AsObject | null, offset = 0, format = "float4"): void {
      const owner = contexts.get(this as unknown as AsObject);
      const backend = owner?.backend;
      const entry = object && buffers.get(object);
      const live = entry && !entry.disposed && contexts.has(entry.owner);
      if (backend && live) {
        if (format === null) {
          throw s.rt.error("TypeError", 2007, "format");
        }

        if (!VERTEX_FORMATS.includes(format as VertexFormat)) {
          throw s.rt.error("ArgumentError", 2008, "format");
        }
      }

      if (index < 0) {
        throw s.rt.error("RangeError", 2006);
      }

      if (index >= VERTEX_SLOTS) {
        throw s.rt.error("RangeError", 2006);
      }

      // AIR takes indices up to 15, which no AGAL 1 program reads: nothing to bind.
      if (!backend || index >= 8) {
        return;
      }

      backend.setVertex(index, live ? entry.value : null, offset, format as VertexFormat);
      owner.vertices[index] = live ? object : null;
    }

    setProgramConstantsFromVector(
      type: string | null,
      first: number,
      values: AsObject,
      count = -1,
    ): void {
      const stage = programType(type);
      const data: number[] = values.$a;
      const entry = state(this as unknown as AsObject);
      const asked = count === -1 ? Math.floor(data.length / 4) : count;
      const registers = within(stage, first, asked);
      if (registers !== 0 || asked === 0) {
        entry.backend.setConstants(stage, first, data, registers);
      }
    }

    /** Little-endian floats whatever the ByteArray's endian, its position left as it is. */
    setProgramConstantsFromByteArray(
      type: string | null,
      first: number,
      count: number,
      data: AsObject | null,
      offset: number,
    ): void {
      const stage = programType(type);
      if (!data) {
        throw s.rt.error("TypeError", 2007, "data");
      }
      if (first < 0) {
        throw s.rt.error("RangeError", 2006);
      }

      const bytes = bindings.bytes(data);
      if (count < 0 || offset + count * 16 > bytes.length) {
        throw s.rt.error("RangeError", 3669);
      }

      const entry = state(this as unknown as AsObject);
      const registers = within(stage, first, count);
      const values = new Float32Array(registers * 4);
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, registers * 16);
      for (let i = 0; i < values.length; i++) {
        values[i] = view.getFloat32(i * 4, true);
      }

      if (registers !== 0 || count === 0) {
        entry.backend.setConstants(stage, first, values, registers);
      }
    }

    setProgramConstantsFromMatrix(
      type: string,
      first: number,
      matrix: AsObject,
      transpose = false,
    ): void {
      const backend = context(this as unknown as AsObject);
      if (type !== "vertex" && type !== "fragment") {
        throw s.rt.error("ArgumentError", 2008, "programType");
      }
      if (!matrix) {
        throw s.rt.error("TypeError", 2007, "matrix");
      }
      if (first < 0) {
        throw s.rt.error("RangeError", 2006);
      }

      const registers = within(type as ProgramType, first, 4);
      const values: Float32Array = matrix.$matrix3D;
      for (let i = 0; i < 16; i++) {
        matrixConstants[i] = values[transpose ? (i % 4) * 4 + Math.floor(i / 4) : i];
      }

      backend.setConstants(type, first, matrixConstants, registers);
    }

    setCulling(face: string): void {
      if (!CULL_FACES.includes(face as CullFace)) {
        throw s.rt.error("ArgumentError", 2008, "triangleFaceToCull");
      }

      // AIR validates enum values but otherwise ignores these setters after disposal.
      contexts.get(this as unknown as AsObject)?.backend.setCulling(face as CullFace);
    }

    setBlendFactors(source: string, destination: string): void {
      if (!BLEND_FACTORS.includes(source as BlendFactor)) {
        throw s.rt.error("ArgumentError", 2008, "sourceFactor");
      }
      if (!BLEND_FACTORS.includes(destination as BlendFactor)) {
        throw s.rt.error("ArgumentError", 2008, "destinationFactor");
      }

      contexts
        .get(this as unknown as AsObject)
        ?.backend.setBlend(source as BlendFactor, destination as BlendFactor);
    }

    setColorMask(red: boolean, green: boolean, blue: boolean, alpha: boolean): void {
      contexts.get(this as unknown as AsObject)?.backend.setColorMask(red, green, blue, alpha);
    }

    setStencilActions(
      face = "frontAndBack",
      compare = "always",
      pass = "keep",
      depthFail = "keep",
      stencilFail = "keep",
    ): void {
      if (!CULL_FACES.includes(face as CullFace)) {
        throw s.rt.error("ArgumentError", 2008, "triangleFace");
      }
      if (!COMPARE_MODES.includes(compare as CompareMode)) {
        throw s.rt.error("ArgumentError", 2008, "compareMode");
      }
      if (!STENCIL_ACTIONS.includes(pass as StencilAction)) {
        throw s.rt.error("ArgumentError", 2008, "actionOnBothPass");
      }
      if (!STENCIL_ACTIONS.includes(depthFail as StencilAction)) {
        throw s.rt.error("ArgumentError", 2008, "actionOnDepthFail");
      }
      if (!STENCIL_ACTIONS.includes(stencilFail as StencilAction)) {
        throw s.rt.error("ArgumentError", 2008, "actionOnDepthPassStencilFail");
      }

      contexts
        .get(this as unknown as AsObject)
        ?.backend.setStencilActions(
          face as CullFace,
          compare as CompareMode,
          pass as StencilAction,
          depthFail as StencilAction,
          stencilFail as StencilAction,
        );
    }

    setStencilReferenceValue(reference: number, readMask = 255, writeMask = 255): void {
      contexts
        .get(this as unknown as AsObject)
        ?.backend.setStencilReference(reference, readMask, writeMask);
    }

    setDepthTest(write: boolean, compare: string): void {
      if (!COMPARE_MODES.includes(compare as CompareMode)) {
        throw s.rt.error("ArgumentError", 2008, "passCompareMode");
      }

      contexts.get(this as unknown as AsObject)?.backend.setDepth(write, compare as CompareMode);
    }

    setScissorRectangle(rect: AsObject | null): void {
      const backend = contexts.get(this as unknown as AsObject)?.backend;
      if (!backend) {
        return;
      }
      if (rect === null) {
        backend.setScissor(null);
        return;
      }

      const rt = s.rt;
      const r = rect as As3<"flash.geom::Rectangle">;
      backend.setScissor(
        rt.toNumber(rt.prop(r, "x")),
        rt.toNumber(rt.prop(r, "y")),
        rt.toNumber(rt.prop(r, "width")),
        rt.toNumber(rt.prop(r, "height")),
      );
    }

    drawTriangles(object: AsObject, first = 0, count = -1): void {
      if (!object) {
        throw s.rt.error("TypeError", 2007, "indexBuffer");
      }

      try {
        const entry = state(this as unknown as AsObject);
        if (entry.compressedTarget) {
          throw s.rt.error("Error", 3746);
        }
        const drawn = entry.program && programs.get(entry.program);
        if (this.$checking) {
          requireClear(entry);
          // Every stream bound is one the program reads.
          const read = drawn && !drawn.disposed ? drawn.value.attributes : -1;
          for (let i = 0; i < entry.vertices.length; i++) {
            if (entry.vertices[i] && !(read & (1 << i))) {
              throw s.rt.error("Error", 3607, i);
            }
          }
        }
        // Every colour output bound, and no more, is one the program writes.
        const outputs = colorOutputs(entry);
        if (drawn && !drawn.disposed && drawn.value.outputs !== outputs) {
          throw s.rt.error("Error", 3774);
        }

        entry.backend.draw(buffer(object), first, count);
      } catch (error) {
        if (error instanceof VertexOffsetError) {
          throw s.rt.error("RangeError", 3610);
        }
        if (error instanceof ScissorBoundsError) {
          throw s.rt.error("Error", 3706);
        }
        if (error instanceof TextureBindingError) {
          switch (error.reason) {
            case "feedback":
              throw s.rt.error("Error", 3604);
            case "unused":
              throw s.rt.error("Error", 3697);
            case "conflicting":
              throw s.rt.error("Error", 3695);
            case "unuploaded":
              throw s.rt.error("Error", 3605);
            case "mipmaps":
              throw s.rt.error("Error", 3700);
            case "streaming":
              throw s.rt.error("Error", 3713);
            case "rectangleMip":
              throw s.rt.error("Error", 3755);
            case "wrap":
              throw s.rt.error("Error", 3753);
            case "dimension":
              throw s.rt.error("Error", 3754);
            case "missing":
              throw s.rt.error("Error", 3663);
            case "format":
              // AIR's message for it changed at SWF 19.
              throw s.rt.error("Error", s.rt.swfVersion >= 19 ? 3763 : 3606, error.sampler);
          }
        }

        throw error;
      }
    }

    drawToBitmapData(destination: AsObject): void {
      const entry = state(this as unknown as AsObject);
      if (!destination) {
        throw s.rt.error("TypeError", 2007, "destination");
      }

      // AIR reads nothing, and checks nothing more, before the back buffer is configured.
      const backend = entry.backend;
      if (backend.width === 0) {
        return;
      }

      requireClear(entry);
      const store = storeOf(s, destination);
      // AIR copies the back buffer's top-left corner to the destination's,
      // as much as both hold, and leaves the rest of the destination alone.
      const width = Math.min(store.width, backend.width);
      const height = Math.min(store.height, backend.height);
      writeReadback(store, backend.read(width, height), width, height, backend.height);
    }

    present(): void {
      const entry = state(this as unknown as AsObject);
      entry.compressedTarget = false;
      resetOutputs(entry);
      // AIR returns to the back buffer even when the following validation fails.
      if (entry.target) {
        entry.backend.setRenderTarget(null);
        entry.target = null;
        entry.targetObject = null;
      }

      // No back buffer: AIR still asks for the clear, then shows nothing and says nothing of it.
      if (!entry.backend.width) {
        const required = entry.depth ? 7 : 1;
        if (this.$checking && (entry.cleared & required) !== required) {
          throw s.rt.error("Error", 3692);
        }

        return;
      }

      // AIR 51 asks only for the colour cleared: a clear of mask 1 lets present through
      // where it still refuses to draw without the depth and stencil cleared.
      if (this.$checking && !(entry.cleared & 1)) {
        throw s.rt.error("Error", 3692);
      }

      entry.backend.present();
      entry.cleared = 0;
    }

    dispose(recreate = true): void {
      const slot = dispose(this as unknown as AsObject);
      if (slot && recreate && !bindings.closed && !s.destroyed) {
        request(slot);
      }
    }
  }

  avm2.registerNativeClass(natives, "flash.display3D::Context3D", ContextNatives);
}
