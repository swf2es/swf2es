// Text as the renderer draws it, worked out apart from any
// GPU: a TextField's or a StaticText's items in order, glyphs of embedded
// fonts placed and coloured, coloured rectangles for a field's background,
// border, selection and caret, and runs of a device font for a canvas to
// rasterize; and the rules for device text's resolution and clipping.
import type { Glyph } from "@swf2es/format";
import type { StaticTextObject, TextObject } from "../display/display.js";
import type { shapeLayers } from "../display/shapes.js";
import { deviceMetrics } from "../text/fonts.js";
import { GUTTER, type LaidChar, shownLines } from "../text/layout.js";

/** Device text rasterized at its largest stretch, with bounded extra texture resolution. */
export function deviceTextResolution(
  world: readonly [number, number, number, number],
  pixels: number,
): number {
  const [a, b, c, d] = world;
  const x = a * a + b * b;
  const y = c * c + d * d;
  const cross = a * c + b * d;
  const stretch = Math.sqrt((x + y + Math.hypot(x - y, 2 * cross)) / 2);
  const base = Number.isFinite(pixels) && pixels > 0 ? pixels : 1;
  if (!Number.isFinite(stretch)) {
    return base;
  }

  // A turn alone must not cross a resolution boundary through rounding error.
  return Math.max(base, Math.min(8 * base, Math.ceil(stretch * base - 1e-6)));
}

/**
 * Whether text laid out at (x, y), `width` by `height`, reaches outside its
 * field, which then clips it: where it lies, as a margin or an indent puts
 * it, not its size alone.
 */
export function overruns(
  field: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  // Within a millionth of a pixel, the field's own size in pixels from its text's in twips
  // rounds off: advanced text, thickened, would be clipped where it only meets the edge.
  const e = 1e-6;
  return (
    x < field.left - e ||
    y < field.top - e ||
    x + width > field.left + field.width + e ||
    y + height > field.top + field.height + e
  );
}

/** A glyph of an embedded font: its outline in the font's units over 20, placed by a matrix in the text's pixels. */
interface GlyphItem {
  kind: "glyph";
  glyph: Glyph;
  em: number;
  m: Affine;
  /** Its colour, ARGB straight. */
  color: number;
}

/** A rectangle in the text's pixels, of one colour, ARGB straight. */
interface RectItem {
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  color: number;
}

/**
 * A run of a device font's characters in one format, for a canvas to draw
 * white and its row to colour, as a glyph is: its top at `x`, `top`.
 */
export interface DeviceItem {
  kind: "device";
  text: string;
  /** The device font's name, size, weight and style, as deviceMetrics measures it. */
  family: string;
  size: number;
  bold: boolean;
  italic: boolean;
  color: number;
  letterSpacing: number;
  ascent: number;
  descent: number;
  x: number;
  top: number;
}

export type TextItem = GlyphItem | RectItem | DeviceItem;

type Affine = { a: number; b: number; c: number; d: number; tx: number; ty: number };

/**
 * What a text's drawing leaves out for now, Saffron's anti-aliasing, drawn
 * as normal; and, where its text runs over, the rectangle inside the
 * field's gutter that clips it, and the items that are its text, from
 * `clipFrom` up to `clipTo`.
 */
export interface TextOmissions {
  advanced: boolean;
  clip: { x: number; y: number; width: number; height: number } | null;
  clipFrom: number;
  clipTo: number;
}

/** A glyph's outline as a shape of one white fill, in the font's units over 20, as shapeLayers takes twips. */
export function glyphShape(glyph: Glyph): Parameters<typeof shapeLayers>[0] {
  return {
    id: 0,
    bounds: { xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
    edgeBounds: null,
    fills: [{ type: "solid", color: 0xffffffff }],
    lines: [],
    records: glyph.records,
    truncated: false,
  };
}

/**
 * A TextField's items: its background and border; each line from the
 * first scrolled to that fits, a character of an embedded font as its
 * glyph at its size and in its colour, a run of a device font in one
 * format as one item on the line's baseline; then, focused, its selection
 * and caret. `omitted` learns what is
 * left out.
 */
export function fieldItems(o: TextObject, omitted: TextOmissions): TextItem[] {
  const items: TextItem[] = [];
  if (o.background) {
    items.push(rect(o.left, o.top, o.width, o.height, 0xff000000 | o.backgroundColor));
  }

  // A border covers the pixels at both edges, x and x + width, as adl draws it.
  if (o.border) {
    const color = 0xff000000 | o.borderColor;
    items.push(
      rect(o.left, o.top, o.width + 1, 1, color),
      rect(o.left, o.top + o.height, o.width + 1, 1, color),
      rect(o.left, o.top + 1, 1, o.height - 1, color),
      rect(o.left + o.width, o.top + 1, 1, o.height - 1, color),
    );
  }

  if (!o.model.text) {
    caret(o, items);
    return items;
  }

  const layout = o.layout;
  const first = Math.min(Math.max(0, o.scrollV - 1), layout.lines.length - 1);
  // The lines that fit the field from there, one at least: adl draws no line part of the way.
  const last = first + shownLines(o, first) - 1;
  const dx = o.left * 20 - o.scrollH * 20;
  const dy = o.top * 20 - (layout.lines[first].y - GUTTER);
  omitted.advanced ||= o.antiAliasType === "advanced";
  let bottom = 0;
  let right = 0;
  let left = Number.POSITIVE_INFINITY;
  const textFrom = items.length;

  for (let l = first; l <= last; l++) {
    const line = layout.lines[l];
    const baseline = (dy + line.y + line.ascent) / 20;
    let run: LaidChar[] = [];
    const flush = () => {
      if (run.length > 0) {
        items.push(deviceRun(o, run, dx, baseline));
        run = [];
      }
    };
    for (const c of line.chars) {
      if (!c.shown) {
        continue;
      }

      if (c.font) {
        flush();
        if (c.glyph) {
          const s = (Math.max(0, c.format.size) * 20) / c.font.em;
          items.push({
            kind: "glyph",
            glyph: c.glyph,
            em: c.font.em,
            m: { a: s, b: 0, c: 0, d: s, tx: (dx + c.x + c.kern) / 20, ty: baseline },
            color: 0xff000000 | c.format.color,
          });
        }
      } else if (run.length > 0 && run[0].format !== c.format) {
        flush();
        run.push(c);
      } else {
        run.push(c);
      }
    }

    flush();
    bottom = Math.max(bottom, dy + line.y + line.ascent + line.descent);
    right = Math.max(right, dx + line.x + line.width);
    left = Math.min(left, dx + line.x);
  }

  // Clipped inside the gutter, as adl clips it: 2 pixels in from each edge.
  const inner = {
    left: o.left + GUTTER / 20,
    top: o.top + GUTTER / 20,
    width: o.width - (2 * GUTTER) / 20,
    height: o.height - (2 * GUTTER) / 20,
  };
  const top = (dy + layout.lines[first].y) / 20;
  if (overruns(inner, left / 20, top, (right - left) / 20, bottom / 20 - top)) {
    omitted.clip = {
      x: inner.left,
      y: inner.top,
      width: Math.max(0, inner.width),
      height: Math.max(0, inner.height),
    };
    omitted.clipFrom = textFrom;
    omitted.clipTo = items.length;
  }

  caret(o, items);
  return items;
}

/**
 * A StaticText's items: each glyph at its height and in its colour, its
 * alpha too, under the text's matrix. Where CSMTextSettings ask for
 * advanced anti-aliasing, `omitted` learns it is drawn as normal.
 */
export function staticItems(o: StaticTextObject, omitted: TextOmissions): TextItem[] {
  const m = o.definition.definition.matrix;
  omitted.advanced ||= Boolean(o.definition.csm?.useFlashType);
  const items: TextItem[] = [];

  for (const placed of o.glyphs.glyphs) {
    // The fill is in the font's units over 20: a height in twips over the em puts it in pixels.
    const s = placed.height / placed.font.em;
    const x = placed.x / 20;
    const y = placed.y / 20;
    items.push({
      kind: "glyph",
      glyph: placed.glyph,
      em: placed.font.em,
      m: {
        a: m.a * s,
        b: m.b * s,
        c: m.c * s,
        d: m.d * s,
        tx: m.a * x + m.c * y + m.tx / 20,
        ty: m.b * x + m.d * y + m.ty / 20,
      },
      color: placed.color,
    });
  }

  return items;
}

function rect(x: number, y: number, width: number, height: number, color: number): RectItem {
  return { kind: "rect", x, y, width, height, color: color >>> 0 };
}

/**
 * A focused input field's caret, a pixel wide and its line's height, in
 * the colour of the text before it, and its selection shaded under it,
 * as adl draws them.
 */
function caret(o: TextObject, items: TextItem[]): void {
  if (!o.focused || !(o.type === "input" || o.selectable)) {
    return;
  }

  const lines = o.layout.lines;
  if (lines.length === 0) {
    return;
  }

  const first = Math.min(Math.max(0, o.scrollV - 1), lines.length - 1);
  const last = first + shownLines(o, first) - 1;
  const dx = o.left * 20 - o.scrollH * 20;
  const dy = o.top * 20 - (lines[first].y - GUTTER);
  const inner = { left: o.left + GUTTER / 20, right: o.left + o.width - GUTTER / 20 };
  const place = (i: number) => {
    const line = lines.find((l) => i < l.end) ?? lines[lines.length - 1];
    const c = line.chars[i - line.start];
    const shown = line.chars.filter((ch) => ch.shown);
    const end = shown[shown.length - 1];
    const x = c ? c.x : end ? end.x + end.advance : line.x;
    return { line, x: (dx + x) / 20 };
  };
  const [begin, end] = o.selection;
  if (begin < end) {
    const from = place(begin);
    const to = place(end);
    const a = lines.indexOf(from.line);
    const b = lines.indexOf(to.line);
    for (let i = Math.max(a, first); i <= Math.min(b, last); i++) {
      const line = lines[i];
      const leftX = i === a ? from.x : (dx + line.x) / 20;
      const shown = line.chars.filter((ch) => ch.shown);
      const lastShown = shown.length > 0 ? shown[shown.length - 1] : null;
      const rightX =
        i === b ? to.x : (dx + (lastShown ? lastShown.x + lastShown.advance : line.x)) / 20;
      const l = Math.max(leftX, inner.left);
      const r = Math.min(rightX, inner.right);
      // 0x3399ff at 0.4.
      items.push(
        rect(
          l,
          (dy + line.y) / 20,
          Math.max(0, r - l),
          (line.ascent + line.descent) / 20,
          0x663399ff,
        ),
      );
    }
  }

  const at = place(o.caret);
  const index = lines.indexOf(at.line);
  if (
    o.type === "input" &&
    index >= first &&
    index <= last &&
    at.x >= inner.left &&
    at.x <= inner.right
  ) {
    const format = o.model.formats[Math.max(0, o.caret - 1)] ?? o.model.defaultFormat;
    const height = Math.max(1, (at.line.ascent + at.line.descent) / 20);
    items.push(rect(at.x, (dy + at.line.y) / 20, 1, height, 0xff000000 | format.color));
  }
}

/** A run of a device font's characters in one format, from where the layout put its first, its top at its ascent above the baseline. */
function deviceRun(o: TextObject, run: LaidChar[], dx: number, baseline: number): DeviceItem {
  const f = run[0].format;
  const text = run.map((c) => (o.displayAsPassword ? "*" : o.model.text[c.index])).join("");
  // As layout sizes it: a size below nothing is none.
  const size = Math.max(0, f.size);
  const metrics = deviceMetrics(f.font, size, f.bold, f.italic);
  return {
    kind: "device",
    text,
    family: f.font,
    size,
    bold: f.bold,
    italic: f.italic,
    color: (0xff000000 | f.color) >>> 0,
    letterSpacing: Number.isFinite(f.letterSpacing) ? f.letterSpacing : 0,
    ascent: metrics.ascent,
    descent: metrics.descent,
    x: (dx + run[0].x) / 20,
    top: baseline - metrics.ascent,
  };
}
