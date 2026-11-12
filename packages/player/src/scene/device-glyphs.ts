// Device text's glyphs rasterized once each, in its font, size and
// resolution and at a quarter-texel phase, on one texture its runs sample:
// a text that changes takes new quads, and no rasterizing nor texture.
import { IDLE_FRAMES, type TextureHandle, type Textures } from "@swf2es/render";

/** Phases a glyph is rasterized at across a texel: where its pen falls between texels, to a quarter. */
export const PHASES = 4;

/** The atlas' width in texels; its height doubles from FIRST_HEIGHT up to MOST_HEIGHT as it fills. */
const WIDTH = 1024;
const FIRST_HEIGHT = 256;
const MOST_HEIGHT = 4096;

/** The most texels a glyph's cell has a side; text larger than that is drawn as runs. */
export const GLYPH_MOST = 256;

/**
 * A glyph's cell in the atlas: its corner and size in texels, and its pen's
 * place inside it, `left` texels in from its left and `up` down from its top,
 * on the baseline.
 */
export interface GlyphCell {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  up: number;
}

/**
 * Characters drawn alike alone and in a run, which no shaping joins or
 * reorders nor combining mark sits on: Latin, Greek, Cyrillic, punctuation,
 * symbols, kana, CJK and Hangul syllables, and halfwidth and fullwidth forms.
 */
const PLAIN =
  /^[\u0020-\u007e\u00a0-\u02ff\u0370-\u03ff\u0400-\u0482\u048a-\u04ff\u2010-\u2027\u2030-\u205e\u20a0-\u20cf\u2100-\u23ff\u2460-\u27bf\u3000-\u3098\u309b-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uff01-\uffee]*$/;

/** Whether a run's characters are each drawn as they would be in it. */
export function plainText(text: string): boolean {
  return PLAIN.test(text);
}

export class DeviceGlyphs {
  /** Moves on when the atlas is emptied, which leaves every cell given before stale. */
  generation = 0;
  /** Whether a cell found no room, the page at its tallest: `clear` empties it. */
  full = false;
  /** How many glyphs it has rasterized. */
  rasterized = 0;
  private height = FIRST_HEIGHT;
  private page = new Uint8Array(WIDTH * FIRST_HEIGHT * 4);
  /** Each glyph's cell by its font, then phase and character; null for one with no ink. */
  private readonly cells = new Map<string, Map<string, GlyphCell | null>[]>();
  /** The font last asked for and its cells, as a run asks for each of its characters in one. */
  private font = "";
  private fontCells: Map<string, GlyphCell | null>[] = [];
  /** The shelf being filled: its top, its height, and how far along it is filled. */
  private shelf = 0;
  private shelfHeight = 0;
  private along = 0;
  private handle: TextureHandle | null = null;
  private canvas: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } | null = null;

  constructor(private readonly textures: Textures) {}

  /**
   * The atlas' texture, added again where it was let go of or lost, as its
   * pixels stay here.
   */
  texture(): TextureHandle {
    if (!this.handle || !this.textures.alive(this.handle)) {
      this.handle = this.textures.add(WIDTH, this.height, this.page, IDLE_FRAMES);
    }

    return this.handle;
  }

  /**
   * The cell of a character in the CSS font `font`, which is in canvas
   * pixels, its pen `phase` quarters of a texel in; null for one with no
   * ink; undefined for one larger than GLYPH_MOST, or where the atlas is
   * `full`.
   */
  cell(font: string, phase: number, char: string): GlyphCell | null | undefined {
    if (font !== this.font) {
      let cells = this.cells.get(font);
      if (!cells) {
        cells = [];
        for (let i = 0; i < PHASES; i++) {
          cells.push(new Map());
        }

        this.cells.set(font, cells);
      }

      this.font = font;
      this.fontCells = cells;
    }

    const cells = this.fontCells[phase];
    const known = cells.get(char);
    if (known !== undefined) {
      return known;
    }

    const context = this.context();
    if (!context) {
      return null;
    }

    context.font = font;
    const m = context.measureText(char);
    const ink = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    if (!(ink > 0) || !(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent > 0)) {
      cells.set(char, null);
      return null;
    }

    // A texel spare round its ink, which smoothing reaches into.
    const shift = phase / PHASES;
    const left = Math.max(0, Math.ceil(m.actualBoundingBoxLeft - shift)) + 1;
    const up = Math.max(0, Math.ceil(m.actualBoundingBoxAscent)) + 1;
    const width = left + Math.max(0, Math.ceil(m.actualBoundingBoxRight + shift)) + 1;
    const height = up + Math.max(0, Math.ceil(m.actualBoundingBoxDescent)) + 1;
    if (width > GLYPH_MOST || height > GLYPH_MOST) {
      return undefined;
    }

    const place = this.place(width, height);
    if (!place) {
      this.full = true;
      return undefined;
    }

    this.rasterized++;
    context.clearRect(0, 0, width, height);
    context.fillText(char, left + shift, up);
    const pixels = context.getImageData(0, 0, width, height).data;
    // The canvas gives straight colour; textures hold it premultiplied.
    const page = this.page;
    for (let row = 0; row < height; row++) {
      let to = ((place.y + row) * WIDTH + place.x) * 4;
      const end = (row + 1) * width * 4;
      for (let i = row * width * 4; i < end; i += 4, to += 4) {
        const alpha = pixels[i + 3];
        page[to] = Math.round((pixels[i] * alpha) / 255);
        page[to + 1] = Math.round((pixels[i + 1] * alpha) / 255);
        page[to + 2] = Math.round((pixels[i + 2] * alpha) / 255);
        page[to + 3] = alpha;
      }
    }

    const cell: GlyphCell = { x: place.x, y: place.y, width, height, left, up };
    cells.set(char, cell);
    if (this.handle && this.textures.alive(this.handle)) {
      this.textures.set(this.handle.id, WIDTH, this.height, this.page);
    }

    return cell;
  }

  /** Emptied, its cells forgotten and the generation moved on, for an atlas full. */
  clear(): void {
    this.cells.clear();
    this.font = "";
    this.full = false;
    this.page.fill(0);
    this.shelf = 0;
    this.shelfHeight = 0;
    this.along = 0;
    this.generation++;
    if (this.handle && this.textures.alive(this.handle)) {
      this.textures.set(this.handle.id, WIDTH, this.height, this.page);
    }
  }

  /** Room for a cell `width` by `height`: on the open shelf, a new one, or a taller page; null for none. */
  private place(width: number, height: number): { x: number; y: number } | null {
    if (this.along + width > WIDTH || height > this.shelfHeight) {
      // A new shelf below, unless this one is empty and only needs to be taller.
      if (this.along > 0) {
        this.shelf += this.shelfHeight;
        this.along = 0;
        this.shelfHeight = 0;
      }

      this.shelfHeight = Math.max(this.shelfHeight, height);
    }

    while (this.shelf + this.shelfHeight > this.height) {
      if (this.height >= MOST_HEIGHT) {
        return null;
      }

      this.grow();
    }

    const x = this.along;
    this.along += width;
    return { x, y: this.shelf };
  }

  /** The page twice as tall, its cells where they were. */
  private grow(): void {
    const page = new Uint8Array(WIDTH * this.height * 2 * 4);
    page.set(this.page);
    this.page = page;
    this.height *= 2;
    if (this.handle && this.textures.alive(this.handle)) {
      this.textures.set(this.handle.id, WIDTH, this.height, this.page);
    }
  }

  /** The canvas glyphs are rasterized on, white on nothing, made as first needed. */
  private context(): CanvasRenderingContext2D | null {
    if (!this.canvas) {
      const canvas = document.createElement("canvas");
      canvas.width = GLYPH_MOST;
      canvas.height = GLYPH_MOST;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        return null;
      }

      context.fillStyle = "#ffffff";
      context.textBaseline = "alphabetic";
      this.canvas = { canvas, context };
    }

    return this.canvas.context;
  }
}
