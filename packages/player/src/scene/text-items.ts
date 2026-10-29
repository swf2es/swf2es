// A text's items drawn (RenderView): glyphs as their fills and rectangles
// as the unit quad, placed by rows of their own, and device text as runs
// rasterized on a canvas, kept as textures while drawn.
import type { ColorTransform } from "@swf2es/format";
import {
  CLAMP,
  type Geometries,
  NORMAL,
  type Rows,
  type SceneList,
  SMOOTH,
  SNAP,
  type TextureHandle,
  type Textures,
} from "@swf2es/render";
import { concatColorInto, IDENTITY_COLOR } from "../display/color.js";
import { makeRoom, moveLast, same } from "../display/value-lists.js";
import { cssFont } from "../text/fonts.js";
import { type Parts, RUN_KEYS } from "./parts.js";
import type { DeviceItem, TextItem } from "./text.js";

/** Runs kept of one text, in its styles, sizes and resolutions. */
const TEXT_RUNS = 8;

/**
 * How many frames a run of device text may go undrawn: a counter or a field
 * typed into makes a new one each frame, which the usual idle frames would
 * hold hundreds of.
 */
const TEXT_IDLE_FRAMES = 30;

/** The most texels a run of device text has a side, under every WebGL 2's least texture size. */
const TEXT_MOST = 4096;

/**
 * A device text run rasterized: its texture, its size and left overhang in
 * canvas pixels at `resolution`; and the style, metrics and resolution it
 * was asked for, which find it again among the runs of its text.
 */
interface DeviceRun {
  handle: TextureHandle;
  width: number;
  height: number;
  left: number;
  resolution: number;
  family: string;
  size: number;
  bold: boolean;
  italic: boolean;
  letterSpacing: number;
  ascent: number;
  descent: number;
  asked: number;
}

export class TextItems {
  /** A text item's colour, and that before its object's, made in place for each item drawn. */
  private readonly itemColor: ColorTransform = { ...IDENTITY_COLOR };
  private readonly itemColored: ColorTransform = { ...IDENTITY_COLOR };
  /** Device text rasterized, by its text; among its runs, by style, metrics and resolution. */
  private readonly runs = new Map<string, DeviceRun[]>();
  /** The canvas device text is rasterized on, made as first needed. */
  private textCanvas: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null =
    null;

  constructor(
    private readonly geometries: Geometries,
    private readonly textures: Textures,
    private readonly parts: Parts,
  ) {}

  /** How many device texts' runs it keeps drawn. */
  get runCount(): number {
    return this.runs.size;
  }

  /**
   * A text's item under the object's transform (a b c d tx ty) and colour
   * transform: a glyph its fill, a rectangle the unit quad, each placed by
   * its row and coloured by its colour as a multiplier before the object's;
   * a device run its rasterized texture, a texel a canvas pixel.
   */
  drawTextItem(
    scene: SceneList,
    rows: Rows,
    item: TextItem,
    a: number,
    b: number,
    c: number,
    d: number,
    tx: number,
    ty: number,
    color: ColorTransform | null,
    resolution: number,
  ): void {
    // Its colour as a multiplier, and that before the object's, in slots of its own: the row
    // made of them copies them.
    const tint = item.color;
    const own = this.itemColor;
    own.rMul = ((tint >>> 16) & 0xff) / 255;
    own.gMul = ((tint >>> 8) & 0xff) / 255;
    own.bMul = (tint & 0xff) / 255;
    own.aMul = (tint >>> 24) / 255;
    const colored = color ? concatColorInto(this.itemColored, color, own) : own;
    if (item.kind === "device") {
      const run = this.deviceRun(item, resolution);
      if (!run) {
        return;
      }

      // A texel a canvas pixel, the run's origin `left` texels in, past its overhang.
      const k = 1 / run.resolution;
      const x = item.x - run.left * k;
      const row = rows.add(
        a * k,
        b * k,
        c * k,
        d * k,
        a * x + c * item.top + tx,
        b * x + d * item.top + ty,
        colored,
      );
      const quad = this.parts.quad(run.width, run.height);
      this.geometries.use(quad.id);
      this.textures.use(run.handle.id);
      scene.draw(quad.id, row, NORMAL, run.handle.id, SMOOTH | CLAMP);
      return;
    }

    const geometry =
      item.kind === "glyph" ? this.parts.glyphGeometry(item.glyph) : this.parts.unitQuad();
    if (!geometry) {
      return;
    }

    const m =
      item.kind === "glyph"
        ? item.m
        : { a: item.width, b: 0, c: 0, d: item.height, tx: item.x, ty: item.y };
    this.geometries.use(geometry.id);
    // A glyph's outline on quarters of a stage pixel, as Flash places it.
    scene.draw(
      geometry.id,
      placedRow(rows, a, b, c, d, tx, ty, m, colored),
      NORMAL,
      -1,
      item.kind === "glyph" ? SNAP : 0,
    );
  }

  /**
   * A run of device text rasterized white at `resolution` canvas pixels a
   * stage pixel, or less where that would pass TEXT_MOST texels a side: its
   * ink whole, the overhang left of its origin and past its advance too, its
   * top at the ascent above the baseline; premultiplied, and kept while
   * drawn, for every colour it is drawn in. Null for nothing to draw.
   */
  private deviceRun(item: DeviceItem, resolution: number): DeviceRun | null {
    // By its text, a string there is already; then its style compared as values.
    let runs = this.runs.get(item.text);
    for (let i = runs ? runs.length - 1 : -1; i >= 0; i--) {
      const run = (runs as DeviceRun[])[i];
      if (
        run.family === item.family &&
        same(run.size, item.size) &&
        run.bold === item.bold &&
        run.italic === item.italic &&
        same(run.letterSpacing, item.letterSpacing) &&
        same(run.ascent, item.ascent) &&
        same(run.descent, item.descent) &&
        same(run.asked, resolution) &&
        this.textures.alive(run.handle)
      ) {
        return i === (runs as DeviceRun[]).length - 1 ? run : moveLast(runs as DeviceRun[], i);
      }
    }

    if (!this.textCanvas) {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return null;
      }

      this.textCanvas = { canvas, context };
    }

    const { canvas, context } = this.textCanvas;
    let scale = resolution;
    let size = { left: 0, width: 0, height: 0 };
    for (let tries = 0; tries < 2; tries++) {
      size = this.measureRun(context, item, scale);
      const most = Math.max(size.width, size.height);
      if (most <= TEXT_MOST) {
        break;
      }

      scale *= TEXT_MOST / most;
    }

    const { left, width, height } = size;
    if (item.size <= 0 || width <= 2 || height <= 2 || width > TEXT_MOST || height > TEXT_MOST) {
      return null;
    }

    canvas.width = width;
    canvas.height = height;
    this.fontAt(context, item, scale);
    context.fillStyle = "#ffffff";
    context.textBaseline = "alphabetic";
    context.fillText(item.text, left, item.ascent * scale + 1);
    const pixels = new Uint8Array(context.getImageData(0, 0, width, height).data.buffer);

    // The canvas gives straight colour; textures hold it premultiplied.
    for (let i = 0; i < pixels.length; i += 4) {
      const alpha = pixels[i + 3];
      pixels[i] = Math.round((pixels[i] * alpha) / 255);
      pixels[i + 1] = Math.round((pixels[i + 1] * alpha) / 255);
      pixels[i + 2] = Math.round((pixels[i + 2] * alpha) / 255);
    }

    // Those let go of are forgotten, so that text typed and scrolled keeps no lists for them.
    if (this.runs.size > RUN_KEYS) {
      for (const [text, list] of this.runs) {
        let kept = 0;
        for (const r of list) {
          if (this.textures.alive(r.handle)) {
            list[kept++] = r;
          }
        }

        list.length = kept;
        if (kept === 0) {
          this.runs.delete(text);
        }
      }

      runs = this.runs.get(item.text);
    }

    const run: DeviceRun = {
      handle: this.textures.add(width, height, pixels, TEXT_IDLE_FRAMES),
      width,
      height,
      left,
      resolution: scale,
      family: item.family,
      size: item.size,
      bold: item.bold,
      italic: item.italic,
      letterSpacing: item.letterSpacing,
      ascent: item.ascent,
      descent: item.descent,
      asked: resolution,
    };
    if (!runs) {
      runs = [];
      this.runs.set(item.text, runs);
    }

    // Its text's runs gone with their textures, and the least lately used past TEXT_RUNS.
    makeRoom(
      runs,
      TEXT_RUNS,
      (r) => !this.textures.alive(r.handle),
      (r) => {
        if (this.textures.alive(r.handle)) {
          this.textures.remove(r.handle.id);
        }
      },
    );
    runs.push(run);
    return run;
  }

  /** The run's font and spacing set on the canvas at `scale` canvas pixels a stage pixel. */
  private fontAt(context: CanvasRenderingContext2D, item: DeviceItem, scale: number): void {
    context.font = cssFont(item.family, item.size * scale, item.bold, item.italic);
    context.letterSpacing = `${item.letterSpacing * scale}px`;
  }

  /** The texels a run takes at `scale`: its ink left of its origin, and its whole width and height, a texel spare round. */
  private measureRun(
    context: CanvasRenderingContext2D,
    item: DeviceItem,
    scale: number,
  ): { left: number; width: number; height: number } {
    this.fontAt(context, item, scale);
    const m = context.measureText(item.text);
    const left = Math.max(0, Math.ceil(m.actualBoundingBoxLeft)) + 1;
    const right = Math.max(m.width, Math.ceil(m.actualBoundingBoxRight));
    return {
      left,
      width: Math.ceil(left + right) + 1,
      height: Math.ceil((item.ascent + item.descent) * scale) + 2,
    };
  }
}

/** A row for what `m` places within an object under the transform (a b c d tx ty). */
export function placedRow(
  rows: Rows,
  a: number,
  b: number,
  c: number,
  d: number,
  tx: number,
  ty: number,
  m: { a: number; b: number; c: number; d: number; tx: number; ty: number },
  color: ColorTransform | null,
): number {
  return rows.add(
    a * m.a + c * m.b,
    b * m.a + d * m.b,
    a * m.c + c * m.d,
    b * m.c + d * m.d,
    a * m.tx + c * m.ty + tx,
    b * m.tx + d * m.ty + ty,
    color,
  );
}
