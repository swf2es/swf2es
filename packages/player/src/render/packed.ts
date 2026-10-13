// What Pixi packs of a context drawn alone, let go of on the CPU once a
// frame has uploaded it, and packed again whenever it is needed there.
import {
  BigPool,
  type Buffer,
  type GraphicsContext,
  GraphicsContextSystem,
  type Renderer,
  RendererType,
  ViewableBuffer,
} from "pixi.js";

/** A context's packed render data, as Pixi keeps it: a batcher with its geometry, and its batches. */
type RenderData = {
  batcher: {
    attributeBuffer: ViewableBuffer;
    indexBuffer: Uint16Array | Uint32Array;
    geometry: { buffers: Buffer[]; indexBuffer: Buffer };
  } | null;
  /** Whether its arrays were let go of, its GPU buffers alone holding what it packed. */
  $dropped?: boolean;
};
type GpuContext = { graphicsData: RenderData | null };
type Uploaded = {
  _data: ArrayLike<number>;
  _dataInt32: Int32Array | null;
  _updateID: number;
  _gpuData: Record<number, { buffer: unknown; updateID: number } | null | undefined>;
};
type ContextSystem = {
  _renderer: Renderer;
  getContextRenderData(context: GraphicsContext): RenderData;
  _initContextRenderData(context: GraphicsContext): RenderData;
};

/** The render data each renderer packed since its last frame ended, to be let go of then. */
const packedOf = new WeakMap<Renderer, [GpuContext, RenderData][]>();

/**
 * Pixi packs the vertices of a context drawn alone into a batcher of its
 * own, uploads them to buffers of their own, and keeps the batcher's
 * arrays for as long as the context lives: in a crowded room, 41 MB of
 * attributes and 33 MB of indices that the GPU already held, beside the
 * transform table's atlas, which holds another copy. Pixi reads them
 * again only to upload them again, once a lost context or its collection
 * of buffers unused for a minute took the GPU's; and the atlas reads them
 * to copy them in. So as each frame ends, what it packed is let go of on
 * the CPU, on WebGL, and packed again (from the context's tessellation,
 * which is kept) when a draw finds its GPU buffers gone, or the atlas
 * needs it (packedOnCpu).
 */
const system = GraphicsContextSystem.prototype as unknown as ContextSystem;
const getContextRenderData = system.getContextRenderData;
system.getContextRenderData = function (context) {
  const gpu = gpuOf(context, this._renderer);
  const data = gpu?.graphicsData;
  if (gpu && data?.$dropped && !resident(data, this._renderer)) {
    repack(gpu, data);
  }

  return getContextRenderData.call(this, context);
};

const initContextRenderData = system._initContextRenderData;
system._initContextRenderData = function (context) {
  const data = initContextRenderData.call(this, context);
  data.$dropped = false;
  const renderer = this._renderer;
  if (renderer.type === RendererType.WEBGL) {
    let packed = packedOf.get(renderer);
    if (!packed) {
      const list: [GpuContext, RenderData][] = [];
      renderer.runners.postrender.add({ postrender: () => dropAll(list) });
      packedOf.set(renderer, list);
      packed = list;
    }

    packed.push([gpuOf(context, renderer) as GpuContext, data]);
  }

  return data;
};

/** `context`'s render data with what it packed on the CPU, packed again if it was let go of. */
export function packedOnCpu(renderer: Renderer, context: GraphicsContext): unknown {
  const gpu = gpuOf(context, renderer);
  const data = gpu?.graphicsData;
  if (gpu && data?.$dropped) {
    repack(gpu, data);
  }

  return renderer.graphicsContext.getContextRenderData(context);
}

function gpuOf(context: GraphicsContext, renderer: Renderer): GpuContext | null | undefined {
  return (context as unknown as { _gpuData: Record<number, GpuContext | null | undefined> })
    ._gpuData[renderer.uid];
}

/** Whether the GPU holds what `data` packed: its buffers there, and up to date. */
function resident(data: RenderData, renderer: Renderer): boolean {
  const geometry = data.batcher?.geometry;
  return (
    !!geometry &&
    uploaded(geometry.buffers[0] as unknown as Uploaded, renderer.uid) &&
    uploaded(geometry.indexBuffer as unknown as Uploaded, renderer.uid)
  );
}

function uploaded(buffer: Uploaded, uid: number): boolean {
  const gpu = buffer._gpuData[uid];
  return !!gpu?.buffer && gpu.updateID === buffer._updateID;
}

/** Have Pixi pack the context again into new render data, as it did as it first drew it. */
function repack(gpu: GpuContext, data: RenderData): void {
  data.$dropped = false;
  BigPool.return(data as never);
  gpu.graphicsData = null;
}

/**
 * Let go of the arrays of what was packed this frame, still the context's:
 * Pixi's buffers are given empty ones of the same kinds, without a change
 * the GPU would upload, as a draw reads the index type from them.
 */
function dropAll(packed: [GpuContext, RenderData][]): void {
  for (const [gpu, data] of packed) {
    const batcher = data.batcher;
    if (!batcher || data.$dropped || gpu.graphicsData !== data) {
      continue;
    }

    batcher.attributeBuffer.destroy();
    batcher.attributeBuffer = new ViewableBuffer(0);
    batcher.indexBuffer = new (batcher.indexBuffer.constructor as Uint16ArrayConstructor)(0);
    const attributes = batcher.geometry.buffers[0] as unknown as Uploaded;
    attributes._data = batcher.attributeBuffer.float32View;
    attributes._dataInt32 = null;
    const indices = batcher.geometry.indexBuffer as unknown as Uploaded;
    indices._data = batcher.indexBuffer;
    indices._dataInt32 = null;
    data.$dropped = true;
  }

  packed.length = 0;
}
