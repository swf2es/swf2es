// BitmapData kept at the display's resolution (RenderViewOptions'
// `bitmapResolution`): vector art a SWF draws into a bitmap the stage's
// size and shows scaled up is stretched, as Flash stretches it, a few
// pixels made many on a large or dense screen. A store made of one colour
// and from then on only drawn into with display objects on the GPU and
// filled is kept instead in a texture at the screen's pixels a stage pixel,
// each draw rendered into it as the stage would render the art, and shown
// by a Bitmap on the stage texel for pixel.
//
// Scripts see the store as Flash keeps it, at its size. Whatever reads its
// pixels or writes them on the CPU, or samples it otherwise than a Bitmap on
// the stage, brings it back at a texel a pixel, and it stays so: drawn again
// there from the draws and fills it went through, which give Flash's pixels
// where nothing they drew has changed since (DisplayObject's `changedAt`),
// else the texture averaged down. The same record draws it again at a new
// scale when the window's changes and stays so for a few frames.

import type { TextureHandle } from "@swf2es/render";
import { BitmapStore } from "../bitmap/bitmap.js";
import { drawDisplayObject } from "../bitmap/draw.js";
import type { PixelRect } from "../bitmap/pixel-rect.js";
import {
  BitmapObject,
  Container,
  type DisplayObject,
  pickWork,
  VideoObject,
} from "../display/display.js";
import type { Paint } from "../display/shapes.js";
import type { DrawCall, Drawer } from "../hosts.js";
import type { Paints } from "./paints.js";

type Affine = { a: number; b: number; c: number; d: number; tx: number; ty: number };

/** The most texels a side of a pixel a store keeps. */
const MOST_ZOOM = 4;
/** The fewest worth keeping: below, the store stays at a texel a pixel. */
const LEAST_ZOOM = 1.1;
/** The most texels one store's texture holds: 64 MB. */
const STORE_TEXELS = 1 << 24;
/** The most texels a draw's samples take at once: a tile's side is this's root over the samples. */
const TILE_TEXELS = 1 << 24;
/** How far the screen's scale may stray from a store's before it is drawn again at it. */
const RESCALE = 0.02;
/** The most draws and fills a store's record keeps (Held's `steps`). */
const MOST_STEPS = 256;
/** Rendered frames a new scale must hold before stores are drawn again at it: a resize's drag passes. */
const STEADY_FRAMES = 8;

/** What a view lends the stores it keeps at display resolution. */
export interface DisplayHost {
  textureLimit(): number;
  /** Screen pixels a stage pixel now. */
  shownScale(): number;
  /** Whether a walk is under way, which a draw of its own would break into. */
  walking(): boolean;
  /** The view as BitmapData.draw takes it, to draw a store again at a texel a pixel. */
  drawer: Drawer;
  /**
   * `o` drawn as BitmapData.draw draws it through `m`, in the store's
   * pixels, at `zoom` texels a pixel, into `width` by `height` texels of
   * texture `id` at (x, y), composited source over; whether it was.
   */
  draw(
    o: DisplayObject,
    m: Affine,
    x: number,
    y: number,
    width: number,
    height: number,
    samples: number,
    zoom: number,
    id: number,
    opaque: boolean,
  ): boolean;
}

/** A draw a store went through: as drawInto took it, in the store's pixels. */
interface DrawStep {
  object: DisplayObject;
  matrix: Affine;
  x: number;
  y: number;
  width: number;
  height: number;
  samples: number;
  /** pickWork.changes once drawn: the object draws so again while nothing in it changed since. */
  epoch: number;
  /** The stores its fills sample, and their versions then, which no Bitmap is told of. */
  sampled: [BitmapStore, number][];
  /** Whether it can be drawn again at all: nothing it draws hangs on what lies outside it. */
  again: boolean;
  /** BitmapData.draw's own matrix, colour transform and clip, which a store drawn again at its size takes. */
  call: DrawCall | null;
}

interface FillStep {
  rect: PixelRect;
  pixel: number;
}

/** A store kept at display resolution: its texture's bytes, and what made it while that can be told. */
interface Held {
  store: WeakRef<BitmapStore>;
  bytes: number;
  /** The colour it was made of, and its draws and fills since, in order; null once it is read back. */
  steps: (DrawStep | FillStep)[] | null;
  solid: number;
  /** A scale it is to be drawn again at, and for how many frames that has held. */
  wanted: number;
  steady: number;
  /** Whether a draw of it could no longer be drawn again: it keeps its scale. */
  fixed: boolean;
}

export class DisplayBitmaps {
  private readonly held: Held[] = [];
  private readonly byStore = new WeakMap<BitmapStore, Held>();
  /** The bytes the textures held take, and the most they may. */
  private bytes = 0;

  constructor(
    private readonly paints: Paints,
    private readonly host: DisplayHost,
    readonly budget: number,
  ) {}

  /** The bytes of texture the stores at display resolution hold now. */
  get heldBytes(): number {
    return this.bytes;
  }

  /** How many stores are at display resolution now. */
  get heldCount(): number {
    return this.held.length;
  }

  /**
   * Texels a pixel `store` is drawn into at: its texture's for one at
   * display resolution, the screen's for one of one colour never read nor
   * written but by its fill, which a texture, the cap on one and the budget
   * hold; null to draw at a texel a pixel.
   */
  zoomFor(store: BitmapStore): number | null {
    if (store.displayRefused || store.holdsAlpha) {
      return null;
    }

    if (store.atDisplay) {
      const zoom = this.paints.zoomOf(store);
      // Its texture gone with a lost context: the store is as the CPU last held it.
      if (zoom === null) {
        store.atDisplay = false;
        store.displayRefused = true;
      }

      return zoom;
    }

    if (store.solidPixel === null || store.newerOnGpu) {
      return null;
    }

    const zoom = this.fit(store, this.host.shownScale());
    if (zoom === null) {
      return null;
    }

    this.prune();
    const bytes = 4 * texelsOf(store.width, zoom) * texelsOf(store.height, zoom);
    return this.bytes + bytes <= this.budget ? zoom : null;
  }

  /** The screen's `shown` scale as a store may keep it: within a texture and the cap; null below the least. */
  private fit(store: BitmapStore, shown: number): number | null {
    const side = Math.max(store.width, store.height);
    const zoom = Math.min(
      shown,
      MOST_ZOOM,
      this.host.textureLimit() / side,
      Math.sqrt(STORE_TEXELS / (store.width * store.height)),
    );
    return zoom >= LEAST_ZOOM ? zoom : null;
  }

  /**
   * `o` drawn into `store` at `zoom` (`zoomFor`), as drawInto takes it, the
   * store made a texture at that scale first if it was not; whether it was.
   */
  drawInto(
    store: BitmapStore,
    o: DisplayObject,
    m: Affine,
    x: number,
    y: number,
    width: number,
    height: number,
    samples: number,
    zoom: number,
    call: DrawCall | null,
  ): boolean {
    let held = this.byStore.get(store);
    let handle: TextureHandle;
    if (store.atDisplay && held) {
      handle = this.paints.storeTexture(store, undefined, true);
    } else {
      const solid = store.solidPixel;
      if (solid === null) {
        return false;
      }

      const across = texelsOf(store.width, zoom);
      const down = texelsOf(store.height, zoom);
      handle = this.paints.scratch(across, down, solid);
      this.paints.adopt(store, handle, zoom);
      store.atDisplay = true;
      held = {
        store: new WeakRef(store),
        bytes: 4 * across * down,
        steps: [],
        solid,
        wanted: 0,
        steady: 0,
        fixed: false,
      };
      this.held.push(held);
      this.byStore.set(store, held);
      this.bytes += held.bytes;
    }

    const sampled: [BitmapStore, number][] = [];
    const step: DrawStep = {
      object: o,
      matrix: m,
      x,
      y,
      width,
      height,
      samples,
      epoch: 0,
      sampled,
      again: call !== null && drawsAgain(o, Number.POSITIVE_INFINITY, sampled),
      call,
    };
    if (!this.render(store, step, zoom, handle.id)) {
      return false;
    }

    step.epoch = pickWork.changes;
    keep(held, step);
    this.paints.drawn(store);
    return true;
  }

  /** `step` drawn into texture `id` of `store` at `zoom`, in tiles a texture's samples hold. */
  private render(store: BitmapStore, step: DrawStep, zoom: number, id: number): boolean {
    const across = texelsOf(store.width, zoom);
    const down = texelsOf(store.height, zoom);
    const x0 = Math.round(step.x * zoom);
    const y0 = Math.round(step.y * zoom);
    const x1 =
      step.x + step.width >= store.width ? across : Math.round((step.x + step.width) * zoom);
    const y1 =
      step.y + step.height >= store.height ? down : Math.round((step.y + step.height) * zoom);
    const samples = Math.max(1, step.samples);
    const side = Math.max(
      64,
      Math.floor(Math.min(this.host.textureLimit(), Math.sqrt(TILE_TEXELS)) / samples),
    );
    // The matrix places the object in the store's pixels from (x, y): each tile from its own corner.
    const m = step.matrix;

    for (let ty = y0; ty < y1; ty += side) {
      for (let tx = x0; tx < x1; tx += side) {
        const placed = {
          ...m,
          tx: m.tx + step.x - tx / zoom,
          ty: m.ty + step.y - ty / zoom,
        };
        const w = Math.min(side, x1 - tx);
        const h = Math.min(side, y1 - ty);
        if (
          !this.host.draw(step.object, placed, tx, ty, w, h, samples, zoom, id, !store.transparent)
        ) {
          return false;
        }
      }
    }

    return true;
  }

  /** `rect` of `store`, at display resolution, set to `pixel` in its texture `handle`, and kept. */
  filled(store: BitmapStore, handle: TextureHandle, rect: PixelRect, pixel: number): boolean {
    const zoom = this.paints.zoomOf(store);
    if (zoom === null) {
      return false;
    }

    const texels = texelRect(store, rect, zoom);
    if (!this.paints.fillStore(handle, texels, pixel)) {
      return false;
    }

    const held = this.byStore.get(store);
    if (held?.steps) {
      // A fill of the whole store starts it again: what was drawn before is gone.
      if (
        rect.x === 0 &&
        rect.y === 0 &&
        rect.width === store.width &&
        rect.height === store.height
      ) {
        held.steps.length = 0;
        held.solid = pixel;
      } else {
        keep(held, { rect: { ...rect }, pixel });
      }
    }

    return true;
  }

  /**
   * `store`'s pixels as Flash's draws would have made them, at its size:
   * its fills and draws done again there on a store of its own, as they
   * would have gone with the option off, which gives them where none of the
   * objects drawn changed since; null where one did, or a walk is under
   * way, and the texture is to be averaged down instead.
   */
  demoted(store: BitmapStore): Uint32Array | null {
    const held = this.byStore.get(store);
    const steps = held?.steps;
    if (held) {
      held.steps = null;
    }

    if (!held || !steps || this.host.walking() || !stillDraws(steps)) {
      return null;
    }

    const again = BitmapStore.filled(store.width, store.height, store.transparent, held.solid);
    again.displayRefused = true;
    try {
      for (const step of steps) {
        if (!("object" in step)) {
          again.fillPixel(step.rect, step.pixel);
        } else if (step.call) {
          const { matrix, color, clip } = step.call;
          drawDisplayObject(
            this.host.drawer,
            again,
            step.object,
            matrix,
            color,
            "normal",
            clip,
            step.samples,
          );
        }
      }

      return again.readable;
    } catch {
      return null;
    } finally {
      again.dispose();
    }
  }

  /**
   * The stores `o` samples that are at display resolution brought back at
   * a texel a pixel, as a draw of `o` reads them: before its walk, which
   * would bring them back only averaged down.
   */
  settle(o: DisplayObject): void {
    if (this.held.length === 0) {
      return;
    }

    visitStores(o, (store) => {
      if (this.paints.zoomOf(store) !== null && store.newerOnGpu) {
        void store.readable;
      }
    });
  }

  /**
   * At the start of a frame: what stores at display resolution no longer
   * hold let go of, and those that may drawn again at a scale of the
   * screen's that has held since a few frames.
   */
  frame(): void {
    this.prune();
    if (this.held.length === 0) {
      return;
    }

    const shown = this.host.shownScale();
    for (const held of this.held) {
      const store = held.store.deref();
      const zoom = store ? this.paints.zoomOf(store) : null;
      if (!store || zoom === null || !held.steps || held.fixed) {
        continue;
      }

      const wanted = this.fit(store, shown) ?? 1;
      if (Math.abs(wanted / zoom - 1) <= RESCALE) {
        held.steady = 0;
        continue;
      }

      if (held.wanted !== wanted) {
        held.wanted = wanted;
        held.steady = 0;
      }

      if (++held.steady < STEADY_FRAMES) {
        continue;
      }

      held.steady = 0;
      this.rescale(store, held, wanted);
    }
  }

  /** `store` drawn again at `zoom` from what made it, where it can be and the budget holds it. */
  private rescale(store: BitmapStore, held: Held, zoom: number): void {
    const steps = held.steps;
    if (!steps || !stillDraws(steps)) {
      held.fixed = true;
      return;
    }

    const across = texelsOf(store.width, zoom);
    const down = texelsOf(store.height, zoom);
    const bytes = 4 * across * down;
    if (this.bytes - held.bytes + bytes > this.budget) {
      return;
    }

    const handle = this.paints.scratch(across, down, held.solid);
    for (const step of steps) {
      const drawn =
        "object" in step
          ? this.render(store, step, zoom, handle.id)
          : this.paints.fillStore(handle, texelRect(store, step.rect, zoom), step.pixel);
      if (!drawn) {
        this.paints.drop(handle);
        held.fixed = true;
        return;
      }
    }

    // What drawing them again changed of the objects drew as it did.
    for (const step of steps) {
      if ("object" in step) {
        step.epoch = pickWork.changes;
      }
    }

    this.paints.adopt(store, handle, zoom);
    this.paints.drawn(store);
    this.bytes += bytes - held.bytes;
    held.bytes = bytes;
  }

  /** The stores no longer held at display resolution, gone, disposed or read back and changed since, let go of. */
  private prune(): void {
    let kept = 0;
    for (const held of this.held) {
      const store = held.store.deref();
      if (store && !store.disposed && this.paints.zoomOf(store) !== null) {
        this.held[kept++] = held;
      } else {
        this.bytes -= held.bytes;
        if (store) {
          this.byStore.delete(store);
        }
      }
    }

    this.held.length = kept;
  }
}

/**
 * `step` kept in `held`'s record, which a store drawn into on and on without
 * a fill of the whole of it outgrows: let go of then, and the store keeps
 * its scale and is averaged down when read.
 */
function keep(held: Held, step: DrawStep | FillStep): void {
  if (!held.steps) {
    return;
  }

  if (held.steps.length >= MOST_STEPS) {
    held.steps = null;
    return;
  }

  held.steps.push(step);
}

/** Texels `n` pixels take at `zoom`: the last partly covered counts. */
export function texelsOf(n: number, zoom: number): number {
  return Math.max(1, Math.ceil(n * zoom - 1e-6));
}

/** `rect` of `store`'s pixels as texels at `zoom`: its edges rounded, the store's own edges its texture's. */
function texelRect(store: BitmapStore, rect: PixelRect, zoom: number): PixelRect {
  const x0 = Math.round(rect.x * zoom);
  const y0 = Math.round(rect.y * zoom);
  const x1 =
    rect.x + rect.width >= store.width
      ? texelsOf(store.width, zoom)
      : Math.round((rect.x + rect.width) * zoom);
  const y1 =
    rect.y + rect.height >= store.height
      ? texelsOf(store.height, zoom)
      : Math.round((rect.y + rect.height) * zoom);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Whether every draw of `steps` would draw as it did. */
function stillDraws(steps: readonly (DrawStep | FillStep)[]): boolean {
  for (const step of steps) {
    if (!("object" in step)) {
      continue;
    }

    if (!step.again || !drawsAgain(step.object, step.epoch, null)) {
      return false;
    }

    for (const [store, version] of step.sampled) {
      if (store.version !== version || store.disposed) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Whether `o` would draw as it did when pickWork.changes was `epoch`:
 * nothing in it changed since, and nothing it draws hangs on what lies
 * outside it or changes unseen (a mask, 3D, a shader, a video). `sampled`,
 * where given, gathers the stores its fills sample, which no change of
 * theirs marks it.
 */
function drawsAgain(
  o: DisplayObject,
  epoch: number,
  sampled: [BitmapStore, number][] | null,
): boolean {
  if (
    o.changedAt > epoch ||
    o.mask !== null ||
    o.maskOf !== null ||
    o.space !== null ||
    o.projection !== null ||
    o.blendShader !== null ||
    o instanceof VideoObject
  ) {
    return false;
  }

  for (const filter of o.filters) {
    if (filter.kind === "shader") {
      return false;
    }
  }

  const layers = o.drawing?.layers;
  if (layers) {
    for (const layer of layers) {
      for (const fill of layer.fills) {
        if (!paintDrawsAgain(fill.fill, sampled)) {
          return false;
        }
      }

      for (const stroke of layer.strokes) {
        if (stroke.paint && !paintDrawsAgain(stroke.paint, sampled)) {
          return false;
        }
      }

      if (layer.meshes?.length || layer.mirrored) {
        return false;
      }
    }
  }

  if (o instanceof Container) {
    for (const child of o.children) {
      if (!drawsAgain(child, epoch, sampled)) {
        return false;
      }
    }
  }

  return true;
}

function paintDrawsAgain(paint: Paint, sampled: [BitmapStore, number][] | null): boolean {
  if (paint.type === "shader") {
    return false;
  }

  if (paint.type === "image" && paint.image instanceof BitmapStore) {
    sampled?.push([paint.image, paint.image.version]);
  }

  return true;
}

/** Each store `o` and what it holds show or fill with. */
function visitStores(o: DisplayObject, visit: (store: BitmapStore) => void): void {
  if (o instanceof BitmapObject && o.store) {
    visit(o.store);
  }

  const layers = o.drawing?.layers;
  if (layers) {
    for (const layer of layers) {
      for (const fill of layer.fills) {
        if (fill.fill.type === "image" && fill.fill.image instanceof BitmapStore) {
          visit(fill.fill.image);
        }
      }

      for (const stroke of layer.strokes) {
        if (stroke.paint?.type === "image" && stroke.paint.image instanceof BitmapStore) {
          visit(stroke.paint.image);
        }
      }

      for (const mesh of layer.meshes ?? []) {
        visit(mesh.image);
      }
    }
  }

  if (o instanceof Container) {
    for (const child of o.children) {
      visitStores(child, visit);
    }
  }
}

/**
 * Premultiplied ARGB `across` by `down` texels at `zoom` a pixel averaged
 * down to `width` by `height` pixels: each channel the mean of what of the
 * texels the pixel covers, by area, rounded. Fills and edges come out as a
 * draw at a texel a pixel gives them, near enough; lines thinner than a
 * pixel lighter, which Flash draws a pixel wide.
 */
export function areaDown(
  texels: Uint32Array,
  across: number,
  down: number,
  width: number,
  height: number,
  zoom: number,
): Uint32Array {
  const out = new Uint32Array(width * height);
  const columns = spans(width, across, zoom);
  const rows = spans(height, down, zoom);
  const sums = new Float64Array(width * 4);

  for (let y = 0; y < height; y++) {
    sums.fill(0);
    let rowsArea = 0;
    for (let k = rows.first[y]; k < rows.first[y + 1]; k++) {
      const wy = rows.weight[k];
      const line = rows.texel[k] * across;
      rowsArea += wy;
      for (let x = 0; x < width; x++) {
        let a = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let j = columns.first[x]; j < columns.first[x + 1]; j++) {
          const w = columns.weight[j];
          const p = texels[line + columns.texel[j]];
          a += (p >>> 24) * w;
          r += ((p >>> 16) & 0xff) * w;
          g += ((p >>> 8) & 0xff) * w;
          b += (p & 0xff) * w;
        }

        const at = x * 4;
        sums[at] += a * wy;
        sums[at + 1] += r * wy;
        sums[at + 2] += g * wy;
        sums[at + 3] += b * wy;
      }
    }

    for (let x = 0; x < width; x++) {
      const area = rowsArea * columns.area[x];
      const at = x * 4;
      const channel = (k: number) =>
        area > 0 ? Math.min(255, Math.round(sums[at + k] / area)) : 0;
      out[y * width + x] =
        ((channel(0) << 24) | (channel(1) << 16) | (channel(2) << 8) | channel(3)) >>> 0;
    }
  }

  return out;
}

/** For each of `n` pixels, the texels of `texels` at `zoom` a pixel it covers and how much of each. */
function spans(
  n: number,
  texels: number,
  zoom: number,
): { first: Int32Array; texel: Int32Array; weight: Float64Array; area: Float64Array } {
  const first = new Int32Array(n + 1);
  const texel: number[] = [];
  const weight: number[] = [];
  const area = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    first[i] = texel.length;
    const from = i * zoom;
    const to = Math.min((i + 1) * zoom, texels);
    for (let t = Math.floor(from); t < to && t < texels; t++) {
      const w = Math.min(to, t + 1) - Math.max(from, t);
      if (w > 1e-9) {
        texel.push(t);
        weight.push(w);
        area[i] += w;
      }
    }
  }

  first[n] = texel.length;
  return { first, texel: Int32Array.from(texel), weight: Float64Array.from(weight), area };
}
