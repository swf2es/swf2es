// Experimental opt-in bindings. Install before loading playerglobal and close
// the host before destroying Scripting; default playback keeps ErrorEvent #3702.

import {
  BLEND_FACTORS,
  type BlendFactor,
  type Buffer3D,
  COMPARE_MODES,
  type CompareMode,
  type Context3D,
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
  type Texture3D,
  TextureBindingError,
  VERTEX_FORMATS,
  type VertexFormat,
  VertexOffsetError,
} from "@swf2es/context3d";
import { avm2 } from "@swf2es/runtime";
import { dispatchEvent } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import { storeOf } from "./flash/display/BitmapData.js";

type AsObject = avm2.AsObject;
type ResourceValue = Buffer3D | Program3D | Texture3D;

interface Resource<T> {
  value: T;
  owner: AsObject;
  disposed: boolean;
  reference: WeakRef<AsObject>;
}

interface TextureResource extends Resource<Texture3D> {
  initialized: boolean;
}

interface ContextState {
  backend: Context3D;
  slot: AsObject;
  cleared: number;
  depth: boolean;
  aa: number;
  target: TextureResource | null;
  targetObject: AsObject | null;
  program: AsObject | null;
  vertices: (AsObject | null)[];
  textures: (AsObject | null)[];
  resources: Set<Resource<ResourceValue>>;
}

/** Returns the host teardown; it also cancels creation queued before teardown. */
export function installContext3D(s: Scripting, host: Stage3DHost): () => void {
  const natives: avm2.Natives = {};
  const slots = new WeakMap<AsObject, AsObject>();
  const pending = new WeakSet<AsObject>();
  const generations = new WeakMap<AsObject, object>();
  const lost = new Map<AsObject, object>();
  const contexts = new Map<AsObject, ContextState>();
  const buffers = new WeakMap<AsObject, Resource<Buffer3D>>();
  const programs = new WeakMap<AsObject, Resource<Program3D>>();
  const textures = new WeakMap<AsObject, TextureResource>();
  const indices = new WeakMap<AsObject, number>();
  const matrixConstants = new Float32Array(16);
  let closed = false;

  const release = (entry: Resource<ResourceValue>): void => {
    contexts.get(entry.owner)?.resources.delete(entry);
    finalized.unregister(entry);
    entry.value.dispose();
    entry.disposed = true;
  };
  // Held records never strongly reference their own AS wrapper. Active bindings
  // keep wrappers alive through ContextState until they are replaced or cleared.
  const finalized = new FinalizationRegistry<Resource<ResourceValue>>((entry) => {
    if (contexts.get(entry.owner)?.resources.has(entry)) {
      release(entry);
    }
  });
  const own = <T extends Resource<ResourceValue>>(object: AsObject, entry: T): T => {
    contexts.get(entry.owner)?.resources.add(entry);
    finalized.register(object, entry, entry);
    return entry;
  };
  const allocate = <T>(owner: AsObject, create: () => T): T => {
    try {
      return create();
    } catch (error) {
      // A full collection can precede its finalizers. Recover that capacity
      // before refusing an allocation, without scanning warm draw paths.
      let collected = false;
      const resources = contexts.get(owner)?.resources;
      if (resources) {
        for (const entry of resources) {
          if (!entry.reference.deref()) {
            release(entry);
            collected = true;
          }
        }
      }
      if (!collected) {
        throw error;
      }

      return create();
    }
  };
  const closeContext = (entry: ContextState): void => {
    for (const resource of entry.resources) {
      finalized.unregister(resource);
    }
    entry.resources.clear();
    entry.vertices.fill(null);
    entry.textures.fill(null);
    entry.program = null;
    entry.target = null;
    entry.targetObject = null;
    entry.backend.dispose();
  };
  const disposeResource = (object: AsObject, entry: Resource<ResourceValue> | undefined): void => {
    if (!entry || entry.disposed) {
      return;
    }

    release(entry);
    const owner = contexts.get(entry.owner);
    if (!owner) {
      return;
    }

    for (let i = 0; i < 8; i++) {
      if (owner.vertices[i] === object) {
        owner.vertices[i] = null;
      }
      if (owner.textures[i] === object) {
        owner.textures[i] = null;
      }
    }
    if (owner.program === object) {
      owner.program = null;
    }
    if (owner.targetObject === object) {
      owner.target = null;
      owner.targetObject = null;
    }
  };

  function unsupported(): never {
    throw new Error("Unsupported operation in Context3D triangle experiment");
  }

  const indexOf = (slot: AsObject): number => {
    let index = indices.get(slot);
    if (index === undefined) {
      const vector = s.rt.getProperty(s.stage?.object, s.rt.publicName("stage3Ds")) as AsObject;
      index = (vector.$a as AsObject[]).indexOf(slot);
      if (index < 0) {
        unsupported();
      }

      indices.set(slot, index);
    }

    return index;
  };
  const place = (slot: AsObject): void => {
    if (!closed && slots.has(slot)) {
      host.place(indexOf(slot), slot.$x ?? 0, slot.$y ?? 0, slot.$visible ?? true);
    }
  };

  const state = (o: AsObject): ContextState => {
    const entry = contexts.get(o);
    if (!entry || entry.backend.disposed) {
      throw s.rt.error("Error", 3694);
    }

    return entry;
  };
  const context = (o: AsObject): Context3D => state(o).backend;
  const requireClear = (entry: ContextState): void => {
    const target = entry.target;
    const required = entry.depth ? 7 : 1;
    if (target ? !target.initialized : (entry.cleared & required) !== required) {
      throw s.rt.error("Error", target ? 3777 : 3692);
    }
  };
  const buffer = (o: AsObject): Buffer3D => {
    const value = buffers.get(o);
    if (!value) {
      throw new Error("Context3D experiment: invalid buffer");
    }

    if (value.disposed || !contexts.has(value.owner)) {
      throw s.rt.error("Error", 3694);
    }

    return value.value;
  };
  const program = (o: AsObject): Program3D => {
    const value = programs.get(o);
    if (!value) {
      throw new Error("Context3D experiment: invalid program");
    }

    if (value.disposed || !contexts.has(value.owner)) {
      throw s.rt.error("Error", 3694);
    }

    return value.value;
  };
  const construct = (
    name: string,
    resource?: ResourceValue,
    namespace = "flash.display3D",
  ): AsObject => {
    try {
      return s.rt.construct(s.rt.classNamed(`${namespace}::${name}`)) as AsObject;
    } catch (error) {
      resource?.dispose();
      throw error;
    }
  };
  const texture = (o: AsObject): Texture3D => {
    const entry = textures.get(o);
    if (!entry) {
      throw new Error("Context3D experiment: invalid texture");
    }
    if (!contexts.has(entry.owner)) {
      throw s.rt.error("Error", 3694);
    }

    return entry.value;
  };
  const bytes = (o: AsObject): Uint8Array => {
    const storage = avm2.bytesOf(s.rt, o);
    return storage.buffer.subarray(0, storage.length);
  };

  const request = (slot: AsObject): void => {
    const generation = {};
    generations.set(slot, generation);
    pending.add(slot);
    s.loads.deferHostEvent(() => {
      pending.delete(slot);
      if (closed || s.destroyed) {
        return;
      }

      const index = indexOf(slot);
      const backend = host.create(index, {
        lost: () => {
          if (closed || s.destroyed || generations.get(slot) !== generation || lost.has(slot)) {
            return;
          }

          const object = slots.get(slot);
          if (!object) {
            return;
          }

          const entry = contexts.get(object);
          contexts.delete(object);
          slots.delete(slot);
          lost.set(slot, generation);
          if (entry) {
            closeContext(entry);
          }
        },
        restored: () => {
          if (closed || s.destroyed || lost.get(slot) !== generation) {
            return;
          }

          lost.delete(slot);
          generations.delete(slot);
          host.remove(index);
          request(slot);
        },
      });
      let object: AsObject;
      try {
        object = construct("Context3D");
      } catch (error) {
        generations.delete(slot);
        backend.dispose();
        host.remove(index);
        throw error;
      }

      contexts.set(object, {
        backend,
        slot,
        cleared: 0,
        depth: false,
        aa: 0,
        target: null,
        targetObject: null,
        program: null,
        vertices: new Array(8).fill(null),
        textures: new Array(8).fill(null),
        resources: new Set(),
      });
      slots.set(slot, object);
      place(slot);
      dispatchEvent(
        s,
        slot,
        s.rt.construct(s.rt.classNamed("flash.events::Event"), "context3DCreate") as AsObject,
      );
    });
  };

  const dispose = (object: AsObject): AsObject | null => {
    const entry = contexts.get(object);
    if (!entry) {
      return null;
    }

    contexts.delete(object);
    slots.delete(entry.slot);
    generations.delete(entry.slot);
    closeContext(entry);
    host.remove(indexOf(entry.slot));
    return entry.slot;
  };

  class StageNatives {
    get context3D(): AsObject | null {
      return slots.get(this as unknown as AsObject) ?? null;
    }

    requestContext3D(mode = "auto", profile = "baseline"): void {
      const slot = this as unknown as AsObject;
      if (
        closed ||
        mode !== "auto" ||
        profile !== "baseline" ||
        slots.has(slot) ||
        pending.has(slot) ||
        lost.has(slot)
      ) {
        unsupported();
      }

      request(slot);
    }
  }

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

      const object = s.rt.construct(
        s.rt.classNamed("flash.display3D.textures::Texture"),
      ) as AsObject;
      const value = allocate(this as unknown as AsObject, () =>
        backend.createTexture(width, height),
      );
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

      const object = s.rt.construct(
        s.rt.classNamed("flash.display3D.textures::CubeTexture"),
      ) as AsObject;
      const value = allocate(this as unknown as AsObject, () =>
        backend.createTexture(size, size, true),
      );
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
      if (slot && recreate && !closed && !s.destroyed) {
        request(slot);
      }
    }
  }

  class BufferNatives {
    uploadFromByteArray(data: AsObject | null, offset: number, start: number, count: number): void {
      if (!data) {
        throw s.rt.error("TypeError", 2007, "data");
      }

      const entry = buffers.get(this as unknown as AsObject);
      if (!entry) {
        throw new Error("Context3D experiment: invalid buffer");
      }

      // Unlike vector uploads, AIR ignores byte uploads after explicit disposal.
      if (entry.disposed) {
        return;
      }

      context(entry.owner);

      const storage = avm2.bytesOf(s.rt, data);
      const value = entry.value;
      const length = count * (value.stride === 0 ? 2 : value.stride * 4);
      if (
        offset < 0 ||
        offset >= storage.length ||
        start < 0 ||
        count < 0 ||
        start > value.count - count ||
        length > storage.length - offset
      ) {
        throw s.rt.error("RangeError", 3669);
      }

      value.uploadBytes(storage.buffer, offset, start, count);
    }

    uploadFromVector(values: AsObject, start: number, count: number): void {
      buffer(this as unknown as AsObject).upload(values.$a, start, count);
    }

    dispose(): void {
      const object = this as unknown as AsObject;
      disposeResource(object, buffers.get(object));
    }
  }

  class ProgramNatives {
    upload(vertex: AsObject, fragment: AsObject): void {
      try {
        program(this as unknown as AsObject).upload(bytes(vertex), bytes(fragment));
      } catch (error) {
        if (error instanceof SamplerBiasError) {
          throw s.rt.error("Error", 3696);
        }

        throw error;
      }
    }

    dispose(): void {
      const object = this as unknown as AsObject;
      disposeResource(object, programs.get(object));
    }
  }

  function uploadTexture(object: AsObject, source: AsObject, level: number, face: number): void {
    const value = texture(object);
    // AIR accepts this call after explicit texture disposal without reviving
    // the resource. A disposed owner context is still rejected above.
    if (textures.get(object)?.disposed) {
      return;
    }

    if (face >= (value.cube ? 6 : 1)) {
      throw s.rt.error("ArgumentError", 3673);
    }
    if (level >= value.levels) {
      throw s.rt.error("ArgumentError", 3674);
    }
    if (!source) {
      throw s.rt.error("TypeError", 2007, "source");
    }

    const bitmap = storeOf(s, source);
    if (
      !value.rectangle &&
      (bitmap.width !== Math.max(1, value.width >> level) ||
        bitmap.height !== Math.max(1, value.height >> level))
    ) {
      unsupported();
    }

    value.upload(bitmap.readable, level, face, bitmap.width, bitmap.height);
    const entry = textures.get(object);
    if (entry && level === 0 && !value.cube) {
      entry.initialized = true;
    }
  }

  function uploadTextureBytes(
    object: AsObject,
    data: AsObject,
    offset: number,
    level: number,
    face: number,
  ): void {
    if (!data) {
      throw s.rt.error("TypeError", 2007, "data");
    }

    // Unlike bitmap uploads, explicit disposal wins over owner disposal.
    if (textures.get(object)?.disposed) {
      return;
    }

    const value = texture(object);
    if (face >= (value.cube ? 6 : 1)) {
      throw s.rt.error("ArgumentError", 3673);
    }
    if (level >= value.levels) {
      throw s.rt.error("ArgumentError", 3674);
    }

    const storage = avm2.bytesOf(s.rt, data);
    const length = Math.max(1, value.width >> level) * Math.max(1, value.height >> level) * 4;
    if (offset > storage.length - length) {
      throw s.rt.error("RangeError", 3669);
    }

    value.uploadBytes(storage.buffer, offset, level, face);
    const entry = textures.get(object);
    if (entry && level === 0 && !value.cube) {
      entry.initialized = true;
    }
  }

  class TextureNatives {
    uploadFromByteArray(data: AsObject, offset: number, level = 0): void {
      uploadTextureBytes(this as unknown as AsObject, data, offset, level, 0);
    }

    uploadFromBitmapData(source: AsObject, level = 0): void {
      uploadTexture(this as unknown as AsObject, source, level, 0);
    }
  }

  class RectangleTextureNatives {
    uploadFromByteArray(data: AsObject, offset: number): void {
      uploadTextureBytes(this as unknown as AsObject, data, offset, 0, 0);
    }

    uploadFromBitmapData(source: AsObject): void {
      if (!source) {
        throw s.rt.error("TypeError", 2007, "source");
      }

      if (textures.get(this as unknown as AsObject)?.disposed) {
        return;
      }

      uploadTexture(this as unknown as AsObject, source, 0, 0);
    }
  }

  class CubeTextureNatives {
    uploadFromByteArray(data: AsObject, offset: number, face: number, level = 0): void {
      uploadTextureBytes(this as unknown as AsObject, data, offset, level, face);
    }

    uploadFromBitmapData(source: AsObject, face: number, level = 0): void {
      uploadTexture(this as unknown as AsObject, source, level, face);
    }
  }

  class TextureBaseNatives {
    dispose(): void {
      const object = this as unknown as AsObject;
      disposeResource(object, textures.get(object));
    }
  }

  avm2.registerNativeClass(natives, "flash.display::Stage3D", StageNatives);
  avm2.registerNativeClass(natives, "flash.display3D::Context3D", ContextNatives);
  avm2.registerNativeClass(natives, "flash.display3D::VertexBuffer3D", BufferNatives);
  avm2.registerNativeClass(natives, "flash.display3D::IndexBuffer3D", BufferNatives);
  avm2.registerNativeClass(natives, "flash.display3D::Program3D", ProgramNatives);
  avm2.registerNativeClass(natives, "flash.display3D.textures::Texture", TextureNatives);
  avm2.registerNativeClass(natives, "flash.display3D.textures::CubeTexture", CubeTextureNatives);
  avm2.registerNativeClass(
    natives,
    "flash.display3D.textures::RectangleTexture",
    RectangleTextureNatives,
  );
  avm2.registerNativeClass(natives, "flash.display3D.textures::TextureBase", TextureBaseNatives);
  // Keep the existing Flash-tested position validation and property storage.
  for (const property of ["x", "y", "visible"]) {
    const key = `flash.display::Stage3D#set:${property}`;
    const original = s.rt.natives[key];
    natives[key] = (rt) => {
      const setter = original(rt);
      return function (this: AsObject, value: avm2.Value) {
        setter.call(this, value);
        place(this);
      };
    };
  }

  Object.assign(s.rt.natives, natives);

  return () => {
    closed = true;
    for (const object of contexts.keys()) {
      dispose(object);
    }
    for (const slot of lost.keys()) {
      generations.delete(slot);
      host.remove(indexOf(slot));
    }
    lost.clear();
  };
}

export type { Context3D, Context3DLifecycle, Stage3DHost } from "@swf2es/context3d";
