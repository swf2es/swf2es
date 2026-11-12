// A text's items drawn (RenderView): glyphs as their fills and rectangles
// as the unit quad, placed by rows of their own, and device text as quads
// of its glyphs in their atlas (device-glyphs.ts), or, where its characters
// would not be drawn alike alone, as runs rasterized on a canvas, kept as
// textures while drawn.
import type { ColorTransform } from "@swf2es/format";
import {
  CLAMP,
  type Geometries,
  type GeometryHandle,
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
import { DeviceGlyphs, GLYPH_MOST, PHASES, plainText } from "./device-glyphs.js";
import type { Parts } from "./parts.js";
import { type DeviceItem, deviceRasterScale, type TextItem } from "./text.js";

/**
 * Device texts with runs kept, past which those let go of are looked for and
 * forgotten; the next look waits for twice as many as it kept, so that many
 * texts drawn at once do not look on every new run.
 */
const RUN_KEYS = 512;

/** Runs kept of one text, in its styles, sizes and resolutions. */
const TEXT_RUNS = 8;

/**
 * How many frames a run of device text may go undrawn: a counter or a field
 * typed into makes a new one each frame, which the usual idle frames would
 * hold hundreds of.
 */
const TEXT_IDLE_FRAMES = 30;

/** How many frames a run of glyph quads may go undrawn, which costs little to place again. */
const GLYPHS_IDLE_FRAMES = 8;

/** The most texels a run of device text has a side, under every WebGL 2's least texture size. */
const TEXT_MOST = 4096;

const WHITE = 0xffffffff;

/**
 * A device text run drawn: its glyphs' quads in the atlas of its
 * generation, at their pens, or its texture rasterized, with its size and
 * left overhang in texels; and the style, metrics and resolution it was
 * asked for, which find it again among the runs of its text: its glyphs'
 * by the resolution they are placed at, its texture's by the scale it was
 * rasterized at (deviceRasterScale).
 */
interface DeviceRun {
  glyphs: GeometryHandle | null;
  generation: number;
  pens: number[] | null;
  handle: TextureHandle | null;
  width: number;
  height: number;
  left: number;
  /**
   * Texels a text pixel it is drawn at; 0 for a texture drawn a texel a
   * canvas pixel at any resolution its scale is asked for.
   */
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
  /** How many texts' runs are kept before those let go of are next looked for. */
  private sweepAt = RUN_KEYS;
  /** The canvas device text is rasterized on, made as first needed. */
  private textCanvas: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null =
    null;
  private readonly glyphs: DeviceGlyphs;
  /** The frame the glyph atlas filled in, after which it is emptied; -1 while it has room. */
  private fullAt = -1;
  private runsRasterized = 0;

  constructor(
    private readonly geometries: Geometries,
    private readonly textures: Textures,
    private readonly parts: Parts,
  ) {
    this.glyphs = new DeviceGlyphs(textures);
  }

  /** How many device texts' runs it keeps drawn. */
  get runCount(): number {
    return this.runs.size;
  }

  /** How many glyphs and runs of device text it has rasterized. */
  get rasterized(): number {
    return this.glyphs.rasterized + this.runsRasterized;
  }

  /**
   * A text's item under the object's transform (a b c d tx ty) and colour
   * transform: a glyph its fill, a rectangle the unit quad, each placed by
   * its row and coloured by its colour as a multiplier before the object's;
   * a device run its rasterized texture, a texel a canvas pixel at
   * `resolution` canvas pixels a pixel of the text, its corner on a canvas
   * pixel, `unit` canvas pixels a stage pixel, where it is neither turned
   * nor skewed.
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
    unit: number,
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

      // A texel a canvas pixel, the run's origin `left` texels in, past its overhang; on a whole
      // canvas pixel, which its texels then each cover, not two halves of two.
      const k = 1 / (run.resolution || resolution);
      const x = item.x - run.left * k;
      let x0 = a * x + c * item.top + tx;
      let y0 = b * x + d * item.top + ty;
      if (b === 0 && c === 0 && unit > 0) {
        x0 = Math.round(x0 * unit) / unit;
        y0 = Math.round(y0 * unit) / unit;
      }

      const row = rows.add(a * k, b * k, c * k, d * k, x0, y0, colored);
      // Its glyphs' quads on their atlas, or its texture's quad.
      const texture = run.glyphs ? this.glyphs.texture() : (run.handle as TextureHandle);
      const geometry = run.glyphs ?? this.parts.quad(run.width, run.height);
      this.geometries.use(geometry.id);
      this.textures.use(texture.id);
      scene.draw(geometry.id, row, NORMAL, texture.id, SMOOTH | CLAMP);
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
   * A run of device text placed at `resolution` canvas pixels a pixel of
   * the text: its glyphs' quads, or rasterized white at its scale for that
   * (deviceRasterScale), or less where that would pass TEXT_MOST texels a side: its
   * ink whole, the overhang left of its origin and past its advance too, its
   * top at the ascent above the baseline; premultiplied, and kept while
   * drawn, for every colour it is drawn in. Null for nothing to draw.
   */
  private deviceRun(item: DeviceItem, resolution: number): DeviceRun | null {
    // The atlas that filled in a frame before is emptied as this one starts, before any run on it
    // is drawn, which leaves them stale with its generation.
    if (this.fullAt >= 0 && this.fullAt !== this.textures.frame) {
      this.glyphs.clear();
      this.fullAt = -1;
    }

    // By its text, a string there is already; then its style compared as values, and the pens of
    // glyph quads, which a justified line spreads.
    const raster = deviceRasterScale(item.size, resolution);
    const runs = this.runs.get(item.text);
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
        same(run.asked, run.glyphs ? resolution : raster) &&
        (run.pens === null || samePens(run.pens, item.pens)) &&
        this.runAlive(run)
      ) {
        return i === (runs as DeviceRun[]).length - 1 ? run : moveLast(runs as DeviceRun[], i);
      }
    }

    const glyphed = this.glyphRun(item, resolution);
    if (glyphed !== undefined) {
      return glyphed && this.keepRun(item, glyphed);
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
    let scale = raster;
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
    this.runsRasterized++;
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

    return this.keepRun(item, {
      glyphs: null,
      generation: 0,
      pens: null,
      handle: this.textures.add(width, height, pixels, TEXT_IDLE_FRAMES),
      width,
      height,
      left,
      resolution: scale === raster ? 0 : scale,
      family: item.family,
      size: item.size,
      bold: item.bold,
      italic: item.italic,
      letterSpacing: item.letterSpacing,
      ascent: item.ascent,
      descent: item.descent,
      asked: raster,
    });
  }

  /**
   * A run of plain characters as quads of their glyphs in the atlas, each
   * pen where the layout put it at `resolution`, to a quarter texel, its
   * glyphs rasterized at their scale for it: null for nothing to
   * draw; undefined for a run drawn rasterized, of other characters, too
   * large, or past what the atlas holds this frame.
   */
  private glyphRun(item: DeviceItem, resolution: number): DeviceRun | null | undefined {
    const text = item.text;
    const pens = item.pens;
    if (
      this.fullAt >= 0 ||
      (item.ascent + item.descent) * resolution + 2 > GLYPH_MOST ||
      !plainText(text)
    ) {
      return undefined;
    }

    const font = cssFont(
      item.family,
      item.size * deviceRasterScale(item.size, resolution),
      item.bold,
      item.italic,
    );
    // On the baseline as the rasterized run has it, a texel below its ascent.
    const baseline = Math.round(item.ascent * resolution) + 1;
    // A quad a character at most, those of no ink left out.
    let positions = new Float32Array(text.length * 8);
    let texels = new Float32Array(text.length * 8);
    let quads = 0;
    for (let i = 0; i < text.length; i++) {
      const pen = pens[i] * resolution;
      let at = Math.floor(pen);
      let phase = Math.round((pen - at) * PHASES);
      if (phase === PHASES) {
        at++;
        phase = 0;
      }

      const cell = this.glyphs.cell(font, phase, text[i]);
      if (cell === undefined) {
        if (this.glyphs.full) {
          this.fullAt = this.textures.frame;
        }

        return undefined;
      }

      if (cell) {
        const x = at - cell.left;
        const y = baseline - cell.up;
        quad(positions, quads, x, y, cell.width, cell.height);
        quad(texels, quads, cell.x, cell.y, cell.width, cell.height);
        quads++;
      }
    }

    if (quads === 0) {
      return null;
    }

    if (quads < text.length) {
      positions = positions.slice(0, quads * 8);
      texels = texels.slice(0, quads * 8);
    }

    const indices = new Uint32Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      const at = q * 6;
      indices[at] = v;
      indices[at + 1] = v + 1;
      indices[at + 2] = v + 2;
      indices[at + 3] = v;
      indices[at + 4] = v + 2;
      indices[at + 5] = v + 3;
    }

    const glyphs = this.geometries.add({
      positions,
      colors: new Uint32Array(quads * 4).fill(WHITE),
      texels,
      indices,
    });
    this.geometries.idleWithin(glyphs.id, GLYPHS_IDLE_FRAMES);
    return {
      glyphs,
      generation: this.glyphs.generation,
      pens,
      handle: null,
      width: 0,
      height: 0,
      left: 0,
      resolution,
      family: item.family,
      size: item.size,
      bold: item.bold,
      italic: item.italic,
      letterSpacing: item.letterSpacing,
      ascent: item.ascent,
      descent: item.descent,
      asked: resolution,
    };
  }

  /** Whether a run can still be drawn: its quads, on the atlas they were placed on, or its texture. */
  private runAlive(run: DeviceRun): boolean {
    return run.glyphs
      ? run.generation === this.glyphs.generation && this.geometries.alive(run.glyphs)
      : run.handle !== null && this.textures.alive(run.handle);
  }

  /** `run` kept among its text's runs, the least lately used past TEXT_RUNS let go of. */
  private keepRun(item: DeviceItem, run: DeviceRun): DeviceRun {
    // Those let go of are forgotten, so that text typed and scrolled keeps no lists for them.
    let runs = this.runs.get(item.text);
    if (this.runs.size > this.sweepAt) {
      for (const [text, list] of this.runs) {
        let kept = 0;
        for (const r of list) {
          if (this.runAlive(r)) {
            list[kept++] = r;
          }
        }

        list.length = kept;
        if (kept === 0) {
          this.runs.delete(text);
        }
      }

      this.sweepAt = Math.max(RUN_KEYS, this.runs.size * 2);
      runs = this.runs.get(item.text);
    }

    if (!runs) {
      runs = [];
      this.runs.set(item.text, runs);
    }

    // Its text's runs gone with their textures, and the least lately used past TEXT_RUNS.
    makeRoom(
      runs,
      TEXT_RUNS,
      (r) => !this.runAlive(r),
      (r) => this.dropRun(r),
    );
    runs.push(run);
    return run;
  }

  /** A run's quads or texture let go of, where they are still its own. */
  private dropRun(run: DeviceRun): void {
    if (run.glyphs && this.geometries.alive(run.glyphs)) {
      this.geometries.remove(run.glyphs.id);
    } else if (run.handle && this.textures.alive(run.handle)) {
      this.textures.remove(run.handle.id);
    }
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

function samePens(a: number[], b: number[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

/** Quad `q`'s corners in `to`, clockwise from its top left at x y, w by h. */
function quad(to: Float32Array, q: number, x: number, y: number, w: number, h: number): void {
  const at = q * 8;
  to[at] = x;
  to[at + 1] = y;
  to[at + 2] = x + w;
  to[at + 3] = y;
  to[at + 4] = x + w;
  to[at + 5] = y + h;
  to[at + 6] = x;
  to[at + 7] = y + h;
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
