// Writes small SWFs for the tests: the tags the player reads first, laid
// out as the SWF specification lays them out, so that a test can say what
// it places and draws without a Flash authoring tool.
export class BitWriter {
  private bytes: number[] = [];
  private bits = 0;
  private current = 0;

  ub(n: number, v: number): this {
    for (let i = n - 1; i >= 0; i--) {
      this.current = (this.current << 1) | (Math.floor(v / 2 ** i) & 1);
      this.bits++;
      if (this.bits === 8) {
        this.bytes.push(this.current);
        this.bits = 0;
        this.current = 0;
      }
    }

    return this;
  }

  sb(n: number, v: number): this {
    return this.ub(n, v < 0 ? v + 2 ** n : v);
  }

  align(): this {
    if (this.bits) {
      this.ub(8 - this.bits, 0);
    }

    return this;
  }

  u8(v: number): this {
    this.align();
    this.bytes.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    return this.u8(v).u8(v >> 8);
  }

  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }

  raw(bytes: Uint8Array | number[]): this {
    this.align();
    // One at a time: spread as arguments, a large ABC overflows the stack.
    for (let i = 0; i < bytes.length; i++) {
      this.bytes.push(bytes[i]);
    }

    return this;
  }

  string(s: string): this {
    return this.raw([...Buffer.from(s, "utf8"), 0]);
  }

  done(): Uint8Array {
    this.align();
    return new Uint8Array(this.bytes);
  }
}

/** Bits for a signed value in SB[n]. */
export function sbits(...values: number[]): number {
  let n = 1;
  for (const v of values) {
    while (v < -(2 ** (n - 1)) || v >= 2 ** (n - 1)) {
      n++;
    }
  }

  return n;
}

/** Bits for an unsigned value in UB[n]. */
function ubits(v: number): number {
  let n = 0;
  while (v >= 2 ** n) {
    n++;
  }

  return n;
}

export function rect(w: BitWriter, xMin: number, xMax: number, yMin: number, yMax: number): void {
  const n = sbits(xMin, xMax, yMin, yMax);
  w.align().ub(5, n).sb(n, xMin).sb(n, xMax).sb(n, yMin).sb(n, yMax).align();
}

/** A MATRIX: scale and rotate as numbers (16.16 fixed), translate in twips. */
export function matrix(
  w: BitWriter,
  m: { a?: number; b?: number; c?: number; d?: number; tx?: number; ty?: number },
): void {
  w.align();
  const a = Math.round((m.a ?? 1) * 65536);
  const d = Math.round((m.d ?? 1) * 65536);
  const b = Math.round((m.b ?? 0) * 65536);
  const c = Math.round((m.c ?? 0) * 65536);
  const scale = a !== 65536 || d !== 65536;
  w.ub(1, scale ? 1 : 0);
  if (scale) {
    const n = sbits(a, d);
    w.ub(5, n).sb(n, a).sb(n, d);
  }

  const rotate = b !== 0 || c !== 0;
  w.ub(1, rotate ? 1 : 0);
  if (rotate) {
    const n = sbits(b, c);
    w.ub(5, n).sb(n, b).sb(n, c);
  }

  const tx = m.tx ?? 0;
  const ty = m.ty ?? 0;
  const n = tx || ty ? sbits(tx, ty) : 0;
  w.ub(5, n).sb(n, tx).sb(n, ty).align();
}

/** A tag; `long` writes the long header even for a short body, as Flash requires of bitmap tags. */
export function tag(code: number, body: Uint8Array, long = false): Uint8Array {
  const w = new BitWriter();
  if (body.length < 0x3f && !long) {
    w.u16((code << 6) | body.length);
  } else {
    w.u16((code << 6) | 0x3f).u32(body.length);
  }

  return concat([w.done(), body]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }

  return out;
}

/** An edge path for a shape: moves, straight lines and curves, in twips, absolute. */
export type PathCommand =
  | { move: [number, number] }
  | { line: [number, number] }
  | { curve: [number, number, number, number] };

export interface ShapeSpec {
  id: number;
  bounds: [number, number, number, number];
  /** Solid fills, 0xRRGGBB (DefineShape) or 0xAARRGGBB (DefineShape3), or bitmap fills. */
  fills: (number | BitmapFill | GradientFillSpec)[];
  /** Lines: width in twips and colour. */
  lines?: { width: number; color: number }[];
  /** Paths, each with the fill it has on its right (fill1) and its line; 1-based, 0 for none. */
  paths: { fill1: number; fill0?: number; line?: number; commands: PathCommand[] }[];
  /** 1 DefineShape (RGB), 3 DefineShape3 (RGBA). */
  version?: 1 | 3;
}

/**
 * A bitmap fill: 0x40 repeating and smoothed, 0x41 clipped and smoothed,
 * 0x42 repeating, 0x43 clipped; its matrix maps the bitmap's pixels to
 * the shape's twips.
 */
export interface BitmapFill {
  bitmap: number;
  type: 0x40 | 0x41 | 0x42 | 0x43;
  matrix?: { a?: number; b?: number; c?: number; d?: number; tx?: number; ty?: number };
}

/**
 * A gradient fill: 0x10 linear, 0x12 radial, 0x13 focal; its matrix maps
 * the gradient square, -16384 to 16384 twips, to the shape's twips.
 */
export interface GradientFillSpec {
  type: 0x10 | 0x12 | 0x13;
  matrix?: { a?: number; b?: number; c?: number; d?: number; tx?: number; ty?: number };
  /** 0 pad, 1 reflect, 2 repeat. */
  spread?: number;
  /** 0 RGB, 1 linear RGB. */
  interpolation?: number;
  /** Ratio 0 to 255 and colour, as the shape's fills are. */
  stops: [number, number][];
  /** A focal gradient's focal point, -1 to 1. */
  focal?: number;
}

/** A DefineShape or DefineShape3 tag. */
export function shape(spec: ShapeSpec): Uint8Array {
  const version = spec.version ?? 1;
  const alpha = version >= 3;
  const lines = spec.lines ?? [];
  const w = new BitWriter();
  w.u16(spec.id);
  rect(w, ...spec.bounds);
  const color = (c: number) => {
    w.u8(c >> 16)
      .u8(c >> 8)
      .u8(c);
    if (alpha) {
      w.u8(c >>> 24);
    }
  };
  w.u8(spec.fills.length);
  for (const f of spec.fills) {
    if (typeof f === "number") {
      w.u8(0);
      color(f);
    } else if ("bitmap" in f) {
      w.u8(f.type).u16(f.bitmap);
      matrix(w, f.matrix ?? {});
    } else {
      w.u8(f.type);
      matrix(w, f.matrix ?? {});
      w.ub(2, f.spread ?? 0)
        .ub(2, f.interpolation ?? 0)
        .ub(4, f.stops.length);
      for (const [ratio, c] of f.stops) {
        w.u8(ratio);
        color(c);
      }

      if (f.type === 0x13) {
        w.u16(Math.round((f.focal ?? 0) * 256) & 0xffff);
      }
    }
  }

  w.u8(lines.length);
  for (const l of lines) {
    w.u16(l.width);
    color(l.color);
  }

  const fillBits = sbits(spec.fills.length);
  const lineBits = sbits(lines.length);
  w.ub(4, fillBits).ub(4, lineBits);
  edges(w, spec.paths, fillBits, lineBits);
  return tag(version === 3 ? 32 : 2, w.done());
}

type MatrixSpec = { a?: number; b?: number; c?: number; d?: number; tx?: number; ty?: number };

/** A morph fill: a solid colour, or a linear or radial gradient, at both ends; colours 0xAARRGGBB. */
export type MorphFillSpec =
  | { start: number; end: number }
  | {
      type: 0x10 | 0x12;
      startMatrix?: MatrixSpec;
      endMatrix?: MatrixSpec;
      /** Each stop's start ratio and colour, then its end ratio and colour. */
      stops: [number, number, number, number][];
    };

export interface MorphShapeSpec {
  id: number;
  startBounds: [number, number, number, number];
  endBounds: [number, number, number, number];
  fills: MorphFillSpec[];
  /** Widths in twips, colours 0xAARRGGBB. */
  lines?: { startWidth: number; endWidth: number; startColor: number; endColor: number }[];
  /** The start's paths, with their styles. */
  start: { fill1?: number; fill0?: number; line?: number; commands: PathCommand[] }[];
  /** The end's: the start's edges in order, its moves where the start has them. */
  end: PathCommand[][];
  /** 1 DefineMorphShape, 2 DefineMorphShape2. */
  version?: 1 | 2;
}

/** A DefineMorphShape or DefineMorphShape2 tag. */
export function morphShape(spec: MorphShapeSpec): Uint8Array {
  const version = spec.version ?? 1;
  const lines = spec.lines ?? [];
  const color = (w: BitWriter, c: number) =>
    w
      .u8(c >> 16)
      .u8(c >> 8)
      .u8(c)
      .u8(c >>> 24);

  // The styles and the start's records, which the offset before them spans.
  const body = new BitWriter();
  body.u8(spec.fills.length);
  for (const f of spec.fills) {
    if ("start" in f) {
      body.u8(0);
      color(body, f.start);
      color(body, f.end);
      continue;
    }

    body.u8(f.type);
    matrix(body, f.startMatrix ?? {});
    matrix(body, f.endMatrix ?? {});
    body.u8(f.stops.length);
    for (const [startRatio, startColor, endRatio, endColor] of f.stops) {
      body.u8(startRatio);
      color(body, startColor);
      body.u8(endRatio);
      color(body, endColor);
    }
  }

  body.u8(lines.length);
  for (const l of lines) {
    body.u16(l.startWidth).u16(l.endWidth);
    if (version === 2) {
      // Round caps and joins, no fill, scaled: LINESTYLE2's flags all zero.
      body.u16(0);
    }

    color(body, l.startColor);
    color(body, l.endColor);
  }

  const fillBits = ubits(spec.fills.length);
  const lineBits = ubits(lines.length);
  body.ub(4, fillBits).ub(4, lineBits);
  edges(body, spec.start, fillBits, lineBits);
  const startPart = body.done();

  const end = new BitWriter();
  end.ub(4, 0).ub(4, 0);
  edges(
    end,
    spec.end.map((commands) => ({ commands })),
    0,
    0,
  );

  const w = new BitWriter();
  w.u16(spec.id);
  rect(w, ...spec.startBounds);
  rect(w, ...spec.endBounds);
  if (version === 2) {
    rect(w, ...spec.startBounds);
    rect(w, ...spec.endBounds);
    // UsesScalingStrokes where there are lines.
    w.u8(lines.length ? 1 : 0);
  }

  w.u32(startPart.length).raw(startPart).raw(end.done());
  return tag(version === 2 ? 84 : 46, w.done());
}

/**
 * A shape's records from the pen at (0, 0), to and with the end record:
 * each path's first move sets its styles, given `fillBits` and `lineBits`
 * (0 and 0 for a morph's end, whose moves set none).
 */
function edges(
  w: BitWriter,
  paths: { fill1?: number; fill0?: number; line?: number; commands: PathCommand[] }[],
  fillBits: number,
  lineBits: number,
): void {
  const styled = fillBits > 0 || lineBits > 0;
  let x = 0;
  let y = 0;
  for (const path of paths) {
    for (const [k, cmd] of path.commands.entries()) {
      if ("move" in cmd) {
        const [mx, my] = cmd.move;
        // A style change: move, and at a path's start its styles.
        const setStyles = k === 0 && styled;
        const flags = 1 | (setStyles ? 2 | 4 | 8 : 0);
        w.ub(1, 0).ub(5, flags);
        const n = sbits(mx, my);
        w.ub(5, n).sb(n, mx).sb(n, my);
        if (setStyles) {
          w.ub(fillBits, path.fill0 ?? 0)
            .ub(fillBits, path.fill1 ?? 0)
            .ub(lineBits, path.line ?? 0);
        }

        x = mx;
        y = my;
      } else if ("line" in cmd) {
        const dx = cmd.line[0] - x;
        const dy = cmd.line[1] - y;
        const n = Math.max(2, sbits(dx, dy));
        w.ub(1, 1)
          .ub(1, 1)
          .ub(4, n - 2)
          .ub(1, 1)
          .sb(n, dx)
          .sb(n, dy);
        x = cmd.line[0];
        y = cmd.line[1];
      } else {
        const [cx, cy, ax, ay] = cmd.curve;
        const d = [cx - x, cy - y, ax - cx, ay - cy];
        const n = Math.max(2, sbits(...d));
        w.ub(1, 1)
          .ub(1, 0)
          .ub(4, n - 2);
        for (const v of d) {
          w.sb(n, v);
        }

        x = ax;
        y = ay;
      }
    }
  }

  w.ub(1, 0).ub(5, 0);
}

export interface PlaceSpec {
  depth: number;
  character?: number;
  move?: boolean;
  matrix?: { a?: number; b?: number; c?: number; d?: number; tx?: number; ty?: number };
  /** A morph shape's ratio, 0 to 65535. */
  ratio?: number;
  name?: string;
  /** The last depth this object masks, as a mask layer does. */
  clipDepth?: number;
  /** PlaceObject3's fields; any of them makes the tag one. */
  className?: string;
  hasImage?: boolean;
  visible?: boolean;
  /** 0xAARRGGBB. */
  opaqueBackground?: number;
}

/** A PlaceObject2 tag, or a PlaceObject3 when the spec has fields only it holds. */
export function place(spec: PlaceSpec): Uint8Array {
  const w = new BitWriter();
  let flags = 0;
  let flags2 = 0;
  if (spec.move) {
    flags |= 0x01;
  }

  if (spec.character !== undefined) {
    flags |= 0x02;
  }

  if (spec.matrix) {
    flags |= 0x04;
  }

  if (spec.ratio !== undefined) {
    flags |= 0x10;
  }

  if (spec.name !== undefined) {
    flags |= 0x20;
  }

  if (spec.clipDepth !== undefined) {
    flags |= 0x40;
  }

  // With HasImage and no character Flash reads a class name anyway, so the
  // flag stays off then, which is what exercises that path in the reader.
  const impliedClass = spec.hasImage && spec.character === undefined;
  if (spec.className !== undefined && !impliedClass) {
    flags2 |= 0x08;
  }

  if (spec.hasImage) {
    flags2 |= 0x10;
  }

  if (spec.visible !== undefined) {
    flags2 |= 0x20;
  }

  if (spec.opaqueBackground !== undefined) {
    flags2 |= 0x40;
  }

  const v3 = flags2 !== 0;
  w.u8(flags);
  if (v3) {
    w.u8(flags2);
  }

  w.u16(spec.depth);
  if (spec.className !== undefined) {
    w.string(spec.className);
  }

  if (spec.character !== undefined) {
    w.u16(spec.character);
  }

  if (spec.matrix) {
    matrix(w, spec.matrix);
  }

  if (spec.ratio !== undefined) {
    w.u16(spec.ratio);
  }

  if (spec.name !== undefined) {
    w.string(spec.name);
  }

  if (spec.clipDepth !== undefined) {
    w.u16(spec.clipDepth);
  }

  if (spec.visible !== undefined) {
    w.u8(spec.visible ? 1 : 0);
  }

  if (spec.opaqueBackground !== undefined) {
    const c = spec.opaqueBackground;
    w.u8(c >>> 24)
      .u8(c >> 16)
      .u8(c >> 8)
      .u8(c);
  }

  return tag(v3 ? 70 : 26, w.done());
}

export function remove(depth: number): Uint8Array {
  return tag(28, new BitWriter().u16(depth).done());
}

export const showFrame = (): Uint8Array => tag(1, new Uint8Array(0));
export const end = (): Uint8Array => tag(0, new Uint8Array(0));

export function backgroundColor(rgb: number): Uint8Array {
  return tag(
    9,
    new BitWriter()
      .u8(rgb >> 16)
      .u8(rgb >> 8)
      .u8(rgb)
      .done(),
  );
}

/** FrameLabel: a name for the frame it is in. */
export function frameLabel(name: string): Uint8Array {
  return tag(43, new BitWriter().string(name).done());
}

/** An EncodedU32: seven bits a byte, low first, the top bit set on all but the last. */
function encodedU32(w: BitWriter, v: number): BitWriter {
  let rest = v >>> 0;
  while (rest >= 0x80) {
    w.u8((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }

  return w.u8(rest);
}

/** DefineSceneAndFrameLabelData: scenes by their first frame, 0 the first, and labels by frame, 0 the first. */
export function sceneData(scenes: [number, string][], labels: [number, string][]): Uint8Array {
  const w = new BitWriter();
  encodedU32(w, scenes.length);
  for (const [offset, name] of scenes) {
    encodedU32(w, offset).string(name);
  }

  encodedU32(w, labels.length);
  for (const [frame, name] of labels) {
    encodedU32(w, frame).string(name);
  }

  return tag(86, w.done());
}

/** FileAttributes: ActionScript 3, as a SWF with a DoABC needs. */
export function fileAttributes(as3: boolean): Uint8Array {
  return tag(69, new BitWriter().u32(as3 ? 0x08 : 0).done());
}

/** A DoABC (code 82) tag, run at once, or, `lazy`, when something first looks up what it defines. */
export function doAbc(abc: Uint8Array, name = "", lazy = false): Uint8Array {
  return tag(
    82,
    new BitWriter()
      .u32(lazy ? 1 : 0)
      .string(name)
      .raw(abc)
      .done(),
  );
}

export function symbolClass(symbols: [number, string][]): Uint8Array {
  const w = new BitWriter().u16(symbols.length);
  for (const [id, name] of symbols) {
    w.u16(id).string(name);
  }

  return tag(76, w.done());
}

/** DefineBinaryData: bytes for a ByteArray subclass that symbolClass binds to `id`. */
export function binaryData(id: number, data: Uint8Array): Uint8Array {
  return tag(87, concat([new BitWriter().u16(id).u32(0).done(), data]), true);
}

/** A DefineSprite with its own tags; they should end with showFrame()s and end(). */
export function sprite(id: number, frameCount: number, tags: Uint8Array[]): Uint8Array {
  return tag(39, concat([new BitWriter().u16(id).u16(frameCount).done(), ...tags]));
}

/**
 * A DefineEditText: its initial text, its size in twips and alignment (0
 * left, 1 right, 2 center), and optionally HTML text, multiline, a colour
 * (0xRRGGBB) and a font by id with its height in twips.
 */
export function editText(
  id: number,
  text: string,
  width = 2000,
  height = 400,
  align = 0,
  options: {
    html?: boolean;
    multiline?: boolean;
    color?: number;
    font?: number;
    fontHeight?: number;
  } = {},
): Uint8Array {
  const w = new BitWriter().u16(id);
  rect(w, 0, width, 0, height);
  const font = options.font !== undefined;
  w.u8(
    0x80 |
      (options.multiline ? 0x20 : 0) |
      (options.color !== undefined ? 0x04 : 0) |
      (font ? 0x01 : 0),
  );
  w.u8((align ? 0x20 : 0) | (options.html ? 0x02 : 0));
  if (font) {
    w.u16(options.font ?? 0).u16(options.fontHeight ?? 240);
  }

  if (options.color !== undefined) {
    w.u8(options.color >> 16)
      .u8(options.color >> 8)
      .u8(options.color)
      .u8(0xff);
  }

  if (align) {
    w.u8(align).u16(0).u16(0).u16(0).u16(0);
  }

  w.string("").string(text);
  return tag(37, w.done());
}

/** A DefineFont2 of a name and no glyphs: what a field names to show its text in. */
export function fontName(id: number, name: string, bold = false, italic = false): Uint8Array {
  const w = new BitWriter().u16(id);
  w.u8((bold ? 0x01 : 0) | (italic ? 0x02 : 0))
    .u8(0)
    .u8(name.length);
  for (const c of name) {
    w.u8(c.charCodeAt(0));
  }

  w.u16(0);
  return tag(48, w.done());
}

/** A glyph of a test font: a character, its advance and its outline's rectangles, in em units of 1024, y down from the baseline. */
export interface GlyphSpec {
  char: string;
  advance: number;
  boxes: [number, number, number, number][];
}

export interface FontSpec {
  id: number;
  name: string;
  bold?: boolean;
  italic?: boolean;
  /** In em units of 1024. */
  ascent: number;
  descent: number;
  leading?: number;
  glyphs: GlyphSpec[];
  /** Pairs of characters and the adjustment between them, in em units. */
  kerning?: [string, string, number][];
}

/**
 * A DefineFont3: glyphs of rectangles, with the layout (ascent, descent,
 * leading, advances, bounds and kerning). Its coordinates are twentieths
 * of DefineFont2's, 20480 to the em.
 */
export function font3(spec: FontSpec): Uint8Array {
  const scale = 20;
  // Flash finds a character by a binary search of the codes: they go in order.
  const sorted = [...spec.glyphs].sort((a, b) => a.char.charCodeAt(0) - b.char.charCodeAt(0));
  const glyphs = sorted.map((g) => {
    const w = new BitWriter();
    w.ub(4, 1).ub(4, 0);
    let x = 0;
    let y = 0;
    const edge = (dx: number, dy: number) => {
      const n = Math.max(2, sbits(dx, dy));
      w.ub(1, 1)
        .ub(1, 1)
        .ub(4, n - 2)
        .ub(1, 1)
        .sb(n, dx)
        .sb(n, dy);
    };
    for (const [k, [x0, y0, x1, y1]] of g.boxes.entries()) {
      const [l, t, r, b] = [x0, y0, x1, y1].map((v) => v * scale);
      // Move, with the fill at the path's start.
      w.ub(1, 0).ub(5, k === 0 ? 1 | 4 : 1);
      const n = sbits(l, t);
      w.ub(5, n).sb(n, l).sb(n, t);
      if (k === 0) {
        w.ub(1, 1);
      }

      x = l;
      y = t;
      for (const [px, py] of [
        [r, t],
        [r, b],
        [l, b],
        [l, t],
      ]) {
        edge(px - x, py - y);
        x = px;
        y = py;
      }
    }

    w.ub(1, 0).ub(5, 0);
    return w.done();
  });

  const w = new BitWriter().u16(spec.id);
  // HasLayout, WideOffsets, WideCodes, italic, bold.
  w.u8(0x80 | 0x08 | 0x04 | (spec.italic ? 0x02 : 0) | (spec.bold ? 0x01 : 0)).u8(0);
  w.u8(spec.name.length);
  for (const c of spec.name) {
    w.u8(c.charCodeAt(0));
  }

  w.u16(glyphs.length);
  // Offsets from the offset table's start, 4 bytes each, then the code table's.
  let at = (glyphs.length + 1) * 4;
  for (const g of glyphs) {
    w.u32(at);
    at += g.length;
  }

  w.u32(at);
  for (const g of glyphs) {
    w.raw(g);
  }

  for (const g of sorted) {
    w.u16(g.char.charCodeAt(0));
  }

  w.u16(spec.ascent * scale)
    .u16(spec.descent * scale)
    .u16((spec.leading ?? 0) * scale);
  for (const g of sorted) {
    w.u16((g.advance * scale) & 0xffff);
  }

  for (const g of sorted) {
    const xs = g.boxes.flatMap((b) => [b[0], b[2]]);
    const ys = g.boxes.flatMap((b) => [b[1], b[3]]);
    const [x0, x1, y0, y1] = xs.length
      ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map((v) => v * scale)
      : [0, 0, 0, 0];
    rect(w, x0, x1, y0, y1);
  }

  const kerning = spec.kerning ?? [];
  w.u16(kerning.length);
  for (const [a, b, adjust] of kerning) {
    w.u16(a.charCodeAt(0))
      .u16(b.charCodeAt(0))
      .u16((adjust * scale) & 0xffff);
  }

  return tag(75, w.done(), true);
}

/** A whole uncompressed SWF: the header, the frame size and rate, then the tags. */
export function swf(options: {
  version?: number;
  width: number;
  height: number;
  frameRate?: number;
  frameCount: number;
  tags: Uint8Array[];
}): Uint8Array {
  const head = new BitWriter();
  rect(head, 0, options.width * 20, 0, options.height * 20);
  head.u16(Math.round((options.frameRate ?? 24) * 256)).u16(options.frameCount);
  const body = concat([head.done(), ...options.tags]);
  const out = new Uint8Array(8 + body.length);
  out.set([0x46, 0x57, 0x53, options.version ?? 10]);
  new DataView(out.buffer).setUint32(4, out.length, true);
  out.set(body, 8);
  return out;
}
