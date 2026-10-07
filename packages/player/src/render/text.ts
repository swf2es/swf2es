// Text drawn: a TextField from its layout, static text from its glyphs,
// and an input field's caret and selection.
import type { Fill, Glyph } from "@swf2es/format";
import {
  CanvasTextMetrics,
  fontStringFromTextStyle,
  Graphics,
  type GraphicsContext,
  Matrix,
  Container as PixiContainer,
  Text,
} from "pixi.js";
import type { StaticTextObject, TextObject } from "../display/display.js";
import { shapeLayers } from "../display/shapes.js";
import { deviceMetrics, fontFamily } from "../text/fonts.js";
import { GUTTER, type LaidChar, shownLines } from "../text/layout.js";
import { SharedGraphics } from "./patches.js";
import { fillContext, paint } from "./tessellate.js";

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
  return (
    x < field.left ||
    y < field.top ||
    x + width > field.left + field.width ||
    y + height > field.top + field.height
  );
}

/** Glyphs' fills, made once and shared by every character drawn in them; null for an empty glyph. */
const glyphFills = new WeakMap<Glyph, GraphicsContext | null>();

/** A glyph's outline as a shape's fill, white for a tint to colour, in the font's units over 20, as shapeLayers takes twips. */
function glyphFill(glyph: Glyph): GraphicsContext | null {
  let context = glyphFills.get(glyph);
  if (context === undefined) {
    const shape = {
      id: 0,
      bounds: { xMin: 0, xMax: 0, yMin: 0, yMax: 0 },
      edgeBounds: null,
      fills: [{ type: "solid" as const, color: 0xffffffff }],
      lines: [],
      records: glyph.records,
      truncated: false,
    };
    const layers = shapeLayers(shape);
    context = layers.length > 0 ? fillContext(layers[0], (fill) => paint(fill as Fill)) : null;
    glyphFills.set(glyph, context);
  }

  return context;
}

/**
 * A TextField drawn from its layout (text/layout.ts): its background and
 * border, then each line from the first scrolled to, a character of an
 * embedded font as its glyph's shape, a run of a device font as one Pixi
 * Text on the line's baseline, each in its own colour, clipped to the
 * field where the text runs over it.
 */
export function drawText(o: TextObject, art: PixiContainer): void {
  if (o.background || o.border) {
    const box = new Graphics();
    if (o.background) {
      box.rect(o.left, o.top, o.width, o.height).fill({ color: o.backgroundColor & 0xffffff });
    }

    // A border covers the pixels at both edges, x and x + width, as adl draws it.
    if (o.border) {
      box
        .rect(o.left + 0.5, o.top + 0.5, o.width, o.height)
        .stroke({ color: o.borderColor & 0xffffff, width: 1 });
    }

    art.addChild(box);
  }

  if (!o.model.text) {
    drawCaret(o, art);
    return;
  }

  const layout = o.layout;
  const first = Math.min(Math.max(0, o.scrollV - 1), layout.lines.length - 1);
  // The lines that fit the field from there, one at least: adl draws no line part of the way.
  const last = first + shownLines(o, first) - 1;
  const dx = o.left * 20 - o.scrollH * 20;
  const dy = o.top * 20 - (layout.lines[first].y - GUTTER);
  const text = new PixiContainer();
  let bottom = 0;
  let right = 0;
  let left = Number.POSITIVE_INFINITY;
  for (let l = first; l <= last; l++) {
    const line = layout.lines[l];
    const baseline = (dy + line.y + line.ascent) / 20;
    let run: LaidChar[] = [];
    const flush = () => {
      if (run.length > 0) {
        text.addChild(deviceRun(o, run, dx, baseline));
        run = [];
      }
    };
    for (const c of line.chars) {
      if (!c.shown) {
        continue;
      }

      if (c.font) {
        flush();
        const fill = c.glyph && glyphFill(c.glyph);
        if (fill) {
          const g = new SharedGraphics(fill);
          const scale = (Math.max(0, c.format.size) * 20) / c.font.em;
          g.scale.set(scale);
          g.position.set((dx + c.x + c.kern) / 20, baseline);
          g.tint = c.format.color & 0xffffff;
          text.addChild(g);
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

  art.addChild(text);
  // Clipped inside the gutter, as adl clips it: 2 pixels in from each edge.
  const inner = {
    left: o.left + GUTTER / 20,
    top: o.top + GUTTER / 20,
    width: o.width - (2 * GUTTER) / 20,
    height: o.height - (2 * GUTTER) / 20,
  };
  // Where the text lies, scrolled: a scroll left of the gutter clips as one past the right does.
  const top = (dy + layout.lines[first].y) / 20;
  if (overruns(inner, left / 20, top, (right - left) / 20, bottom / 20 - top)) {
    const clip = new Graphics()
      .rect(inner.left, inner.top, Math.max(0, inner.width), Math.max(0, inner.height))
      .fill({ color: 0xffffff });
    art.addChild(clip);
    text.mask = clip;
  }

  drawCaret(o, art);
}

/** Static text: each glyph's shared fill, at its height and in its colour, under the text's matrix. */
export function drawStaticText(o: StaticTextObject, art: PixiContainer): void {
  const m = o.definition.definition.matrix;
  const text = new PixiContainer();
  text.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, m.tx / 20, m.ty / 20));
  for (const placed of o.glyphs.glyphs) {
    const fill = glyphFill(placed.glyph);
    if (!fill) {
      continue;
    }

    // The fill is in the font's units over 20: a height in twips over the em puts it in pixels.
    const g = new SharedGraphics(fill);
    g.scale.set(placed.height / placed.font.em);
    g.position.set(placed.x / 20, placed.y / 20);
    g.tint = placed.color & 0xffffff;
    g.alpha = (placed.color >>> 24) / 255;
    text.addChild(g);
  }

  art.addChild(text);
}

/**
 * A focused input field's caret, a pixel wide and its line's height, in
 * the colour of the text before it, and its selection shaded under it.
 */
function drawCaret(o: TextObject, art: PixiContainer): void {
  if (!o.focused || !(o.type === "input" || o.selectable)) {
    return;
  }

  const layout = o.layout;
  const lines = layout.lines;
  if (lines.length === 0) {
    return;
  }

  const first = Math.min(Math.max(0, o.scrollV - 1), lines.length - 1);
  const last = first + shownLines(o, first) - 1;
  const dx = o.left * 20 - o.scrollH * 20;
  const dy = o.top * 20 - (lines[first].y - GUTTER);
  // Inside the gutter, as the text is clipped: a caret scrolled out of view is not drawn.
  const inner = {
    left: o.left + GUTTER / 20,
    right: o.left + o.width - GUTTER / 20,
  };
  // Where index i is drawn: its line, and its x, the line's end past its last character.
  const place = (i: number) => {
    const line = lines.find((l) => i < l.end) ?? lines[lines.length - 1];
    const c = line.chars[i - line.start];
    const shown = line.chars.filter((ch) => ch.shown);
    const last = shown[shown.length - 1];
    const x = c ? c.x : last ? last.x + last.advance : line.x;
    return { line, x: (dx + x) / 20 };
  };
  const g = new Graphics();
  const [begin, end] = o.selection;
  if (begin < end) {
    const from = place(begin);
    const to = place(end);
    const a = lines.indexOf(from.line);
    const b = lines.indexOf(to.line);
    // Each shown line the selection covers, from its start or to its end where it goes on.
    for (let i = Math.max(a, first); i <= Math.min(b, last); i++) {
      const line = lines[i];
      const left = i === a ? from.x : (dx + line.x) / 20;
      const shown = line.chars.filter((ch) => ch.shown);
      const end = shown.length > 0 ? shown[shown.length - 1] : null;
      const right = i === b ? to.x : (dx + (end ? end.x + end.advance : line.x)) / 20;
      // Within the gutter, as the text is: a line wider than the field is clipped there.
      const l = Math.max(left, inner.left);
      const r = Math.min(right, inner.right);
      const top = (dy + line.y) / 20;
      const height = (line.ascent + line.descent) / 20;
      g.rect(l, top, Math.max(0, r - l), height).fill({ color: 0x3399ff, alpha: 0.4 });
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
    const top = (dy + at.line.y) / 20;
    const height = Math.max(1, (at.line.ascent + at.line.descent) / 20);
    g.rect(at.x, top, 1, height).fill({ color: format.color & 0xffffff });
  }

  art.addChild(g);
}

/** A run of a device font's characters in one format, as Pixi Text from where the layout put its first, on the baseline. */
function deviceRun(o: TextObject, run: LaidChar[], dx: number, baseline: number): Text {
  const f = run[0].format;
  const chars = run.map((c) => (o.displayAsPassword ? "*" : o.model.text[c.index])).join("");
  const style = {
    fontFamily: fontFamily(f.font),
    fontSize: f.size,
    fill: f.color & 0xffffff,
    fontWeight: f.bold ? ("bold" as const) : ("normal" as const),
    fontStyle: f.italic ? ("italic" as const) : ("normal" as const),
    letterSpacing: f.letterSpacing,
  };
  const t = new Text({ text: chars, style });
  // Pixi's Text puts its top at its font's ascent above the baseline; without a DOM (node) there is no font to measure.
  const ascent =
    typeof document === "undefined"
      ? deviceMetrics(f.font, f.size, f.bold, f.italic).ascent
      : CanvasTextMetrics.measureFont(fontStringFromTextStyle(t.style)).ascent;
  t.position.set((dx + run[0].x) / 20, baseline - ascent);
  return t;
}
