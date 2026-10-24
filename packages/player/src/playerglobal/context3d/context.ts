import {
  BLEND_FACTORS,
  type BlendFactor,
  COMPARE_MODES,
  type CompareMode,
  CULL_FACES,
  type CullFace,
  SAMPLER_FILTERS,
  SAMPLER_MIPS,
  SAMPLER_WRAPS,
  type SamplerFilter,
  type SamplerMip,
  type SamplerWrap,
  ScissorBoundsError,
  STENCIL_ACTIONS,
  type StencilAction,
  TextureBindingError,
  VERTEX_FORMATS,
  type VertexFormat,
  VertexOffsetError,
} from "@swf2es/context3d";
import { avm2 } from "@swf2es/runtime";
import type { Scripting } from "../../scripting.js";
import { storeOf } from "../flash/display/BitmapData.js";

import { type AsObject, type Bindings, unsupported } from "./lifecycle.js";

export function registerContext(natives: avm2.Natives, s: Scripting, bindings: Bindings): void {
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

  class ContextNatives {
    get driverInfo(): string {
      return contexts.has(this as unknown as AsObject) ? "swf2es experimental WebGL2" : "Disposed";
    }

    get profile(): string | null {
      return contexts.has(this as unknown as AsObject) ? "baseline" : null;
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

    configureBackBuffer(
      width: number,
      height: number,
      aa: number,
      depth = true,
      best = false,
      zoom = false,
    ): void {
      const entry = state(this as unknown as AsObject);
      const backend = entry.backend;
      if (width < 32) {
        throw s.rt.error("Error", 3780, 32, 2048);
      }
      if (height < 32) {
        throw s.rt.error("Error", 3781, 32, 2048);
      }

      if (best || zoom) {
        unsupported();
      }

      const changed =
        width !== backend.width ||
        height !== backend.height ||
        depth !== entry.depth ||
        aa !== entry.aa;
      backend.configure(width, height, depth, aa);
      if (changed) {
        entry.cleared = 0;
      }

      entry.depth = depth;
      entry.aa = aa;
    }

    clear(r = 0, g = 0, b = 0, a = 1, depth = 1, stencil = 0, mask = 0xffffffff): void {
      const entry = state(this as unknown as AsObject);
      const backend = entry.backend;
      if (backend.width === 0) {
        throw s.rt.error("Error", 3698);
      }

      if (mask !== 0xffffffff && mask > 7) {
        unsupported();
      }

      backend.clear(r, g, b, a, depth, mask, stencil);
      // Only successful AS3 clears count, not the backend's allocation-time clear.
      if (entry.target) {
        entry.target.initialized = true;
      } else {
        entry.cleared |= mask & (entry.depth ? 7 : 1);
      }
    }

    createVertexBuffer(count: number, stride: number, usage = "staticDraw"): AsObject {
      if (usage !== "staticDraw" || stride === 0) {
        unsupported();
      }

      const owner = this as unknown as AsObject;
      const resource = allocate(owner, () => context(owner).createBuffer(count, stride));
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

    createIndexBuffer(count: number, usage = "staticDraw"): AsObject {
      if (usage !== "staticDraw") {
        unsupported();
      }

      const owner = this as unknown as AsObject;
      const resource = allocate(owner, () => context(owner).createBuffer(count, 0));
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
      const backend = context(this as unknown as AsObject);
      if (format !== "bgra" || levels !== 0) {
        unsupported();
      }

      const value = allocate(this as unknown as AsObject, () =>
        backend.createTexture(width, height),
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
      const backend = context(this as unknown as AsObject);
      if (format === null) {
        throw s.rt.error("TypeError", 2007, "format");
      }
      switch (format) {
        case "bgra":
        case "bgraPacked4444":
        case "bgrPacked565":
        case "compressed":
        case "compressedAlpha":
        case "rgbaHalfFloat":
          break;
        default:
          throw s.rt.error("ArgumentError", 2008, "format");
      }
      if (width <= 0 || height <= 0) {
        throw s.rt.error("ArgumentError", 3681);
      }
      if (width > 2048 || height > 2048) {
        throw s.rt.error("ArgumentError", 3766);
      }
      if (format !== "bgra") {
        unsupported();
      }

      const value = allocate(this as unknown as AsObject, () =>
        backend.createRectangleTexture(width, height),
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
      const backend = context(this as unknown as AsObject);
      if (format !== "bgra" || levels !== 0) {
        unsupported();
      }

      const value = allocate(this as unknown as AsObject, () =>
        backend.createTexture(size, size, true),
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
      if (output !== 0) {
        unsupported();
      }

      const entry = state(this as unknown as AsObject);
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

      entry.backend.setRenderTarget(value, depth, surface, aa);
      entry.target = value && object ? (textures.get(object) ?? null) : null;
      entry.targetObject = value ? object : null;
    }

    setRenderToBackBuffer(): void {
      const entry = state(this as unknown as AsObject);
      entry.backend.setRenderTarget(null);
      entry.target = null;
      entry.targetObject = null;
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

      if (index >= 8) {
        unsupported();
      }

      if (!backend) {
        return;
      }

      backend.setVertex(index, live ? entry.value : null, offset, format as VertexFormat);
      owner.vertices[index] = live ? object : null;
    }

    setProgramConstantsFromVector(type: string, first: number, values: AsObject, count = -1): void {
      if (type !== "vertex" && type !== "fragment") {
        unsupported();
      }

      const data: number[] = values.$a;
      context(this as unknown as AsObject).setConstants(
        type,
        first,
        data,
        count === -1 ? Math.floor(data.length / 4) : count,
      );
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

      const values: Float32Array = matrix.$matrix3D;
      for (let i = 0; i < 16; i++) {
        matrixConstants[i] = values[transpose ? (i % 4) * 4 + Math.floor(i / 4) : i];
      }

      backend.setConstants(type, first, matrixConstants, 4);
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
      backend.setScissor(
        rt.toNumber(rt.getProperty(rect, rt.publicName("x"))),
        rt.toNumber(rt.getProperty(rect, rt.publicName("y"))),
        rt.toNumber(rt.getProperty(rect, rt.publicName("width"))),
        rt.toNumber(rt.getProperty(rect, rt.publicName("height"))),
      );
    }

    drawTriangles(object: AsObject, first = 0, count = -1): void {
      if (!object) {
        throw s.rt.error("TypeError", 2007, "indexBuffer");
      }

      try {
        const entry = state(this as unknown as AsObject);
        if (this.$checking) {
          requireClear(entry);
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
            case "rectangleMip":
              throw s.rt.error("Error", 3755);
            case "wrap":
              throw s.rt.error("Error", 3753);
            case "dimension":
              throw s.rt.error("Error", 3754);
            case "missing":
              throw s.rt.error("Error", 3663);
          }
        }

        throw error;
      }
    }

    drawToBitmapData(destination: AsObject): void {
      const entry = state(this as unknown as AsObject);
      const backend = entry.backend;
      if (backend.width === 0) {
        return;
      }

      requireClear(entry);
      const store = storeOf(s, destination);
      // AIR can preserve alpha in opaque targets, outside BitmapStore's current
      // opaque-pixel invariant. Different sizes and clipping need separate probes.
      if (!store.transparent || store.width !== backend.width || store.height !== backend.height) {
        unsupported();
      }

      const rgba = backend.read();
      const pixels = store.pixels;
      for (let i = 0; i < pixels.length; i++) {
        const at = i * 4;
        // AIR preserves RGB and raises alpha to cover every channel.
        // Multiplying RGB here would darken textures twice.
        const alpha = Math.max(rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]);
        pixels[i] = (alpha << 24) | (rgba[at] << 16) | (rgba[at + 1] << 8) | rgba[at + 2];
      }

      store.changed();
    }

    present(): void {
      const entry = state(this as unknown as AsObject);
      // AIR returns to the back buffer even when the following validation fails.
      if (entry.target) {
        entry.backend.setRenderTarget(null);
        entry.target = null;
        entry.targetObject = null;
      }

      if (this.$checking) {
        requireClear(entry);
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
