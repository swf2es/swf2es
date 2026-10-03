// Shapes as DefineShape, DefineShape2, DefineShape3 and DefineShape4 hold
// them (SWF specification, chapter 6): fill and line styles, then shape
// records, edges in twips relative to the pen and style changes that move
// it or switch styles, until an end record; and morph shapes, which hold
// two such shapes to blend. The player turns the edges into closed paths
// per fill; this file only decodes them.
import { type Rect, SwfReader } from "./swf.js";
import {
  DefineMorphShape,
  DefineMorphShape2,
  DefineShape,
  DefineShape2,
  DefineShape3,
  DefineShape4,
} from "./tags.js";

/** An affine transform as MATRIX holds one: a, b, c, d as numbers, tx and ty in twips. */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

/** A colour transform, as CXFORM or, with alpha, CXFORMWITHALPHA: multipliers /256, offsets. */
export interface ColorTransform {
  rMul: number;
  gMul: number;
  bMul: number;
  aMul: number;
  rAdd: number;
  gAdd: number;
  bAdd: number;
  aAdd: number;
}

export interface GradientStop {
  ratio: number;
  /** 0xAARRGGBB. */
  color: number;
}

export interface Gradient {
  matrix: Matrix;
  /** 0 pad, 1 reflect, 2 repeat. */
  spread: number;
  /** 0 normal RGB, 1 linear RGB. */
  interpolation: number;
  stops: GradientStop[];
  /** A focal gradient's focal point, -1 to 1; 0 for any other. */
  focal: number;
}

export type Fill =
  | { type: "solid"; color: number }
  | { type: "linear" | "radial" | "focal"; gradient: Gradient }
  | { type: "bitmap"; bitmap: number; matrix: Matrix; repeat: boolean; smooth: boolean };

export interface Line {
  /** Width in twips; 0 is a hairline. */
  width: number;
  /** 0xAARRGGBB, or the colour of a gradient's first stop for a filled line. */
  color: number;
  /** DefineShape4's LINESTYLE2 fields, else a round line. */
  startCap: number;
  endCap: number;
  /** 0 round, 1 bevel, 2 miter. */
  join: number;
  miterLimit: number;
  noHScale: boolean;
  noVScale: boolean;
  pixelHinting: boolean;
  noClose: boolean;
  fill: Fill | null;
}

/**
 * A shape record: a style change, which may move the pen (moveTo, absolute),
 * switch fills and line (0 for none, else 1-based into the styles in force),
 * and bring new styles; or an edge from the pen, straight or quadratic,
 * with its deltas in twips.
 */
export type ShapeRecord =
  | {
      type: "style";
      moveTo: { x: number; y: number } | null;
      fill0: number | null;
      fill1: number | null;
      line: number | null;
      styles: { fills: Fill[]; lines: Line[] } | null;
    }
  | { type: "line"; dx: number; dy: number }
  | { type: "curve"; cx: number; cy: number; ax: number; ay: number };

export interface Shape {
  id: number;
  bounds: Rect;
  /** DefineShape4's bounds without the lines' widths. */
  edgeBounds: Rect | null;
  fills: Fill[];
  lines: Line[];
  records: ShapeRecord[];
  /** Whether the records ran past the tag's end. */
  truncated: boolean;
}

export function readMatrix(r: SwfReader): Matrix {
  r.align();
  const m = { ...IDENTITY };

  if (r.ub(1)) {
    const n = r.ub(5);
    m.a = r.sb(n) / 65536;
    m.d = r.sb(n) / 65536;
  }

  if (r.ub(1)) {
    const n = r.ub(5);
    m.b = r.sb(n) / 65536;
    m.c = r.sb(n) / 65536;
  }

  const n = r.ub(5);
  m.tx = r.sb(n);
  m.ty = r.sb(n);
  r.align();
  return m;
}

export function readColorTransform(r: SwfReader, alpha: boolean): ColorTransform {
  r.align();
  const hasAdd = r.ub(1);
  const hasMul = r.ub(1);
  const n = r.ub(4);
  const ct = { rMul: 1, gMul: 1, bMul: 1, aMul: 1, rAdd: 0, gAdd: 0, bAdd: 0, aAdd: 0 };

  if (hasMul) {
    ct.rMul = r.sb(n) / 256;
    ct.gMul = r.sb(n) / 256;
    ct.bMul = r.sb(n) / 256;
    if (alpha) {
      ct.aMul = r.sb(n) / 256;
    }
  }

  if (hasAdd) {
    ct.rAdd = r.sb(n);
    ct.gAdd = r.sb(n);
    ct.bAdd = r.sb(n);
    if (alpha) {
      ct.aAdd = r.sb(n);
    }
  }

  r.align();
  return ct;
}

/** RGB, or RGBA with alpha, as 0xAARRGGBB. */
function readColor(r: SwfReader, alpha: boolean): number {
  const red = r.u8();
  const green = r.u8();
  const blue = r.u8();
  const a = alpha ? r.u8() : 255;
  return ((a << 24) | (red << 16) | (green << 8) | blue) >>> 0;
}

function readGradient(r: SwfReader, alpha: boolean, focal: boolean): Gradient {
  const matrix = readMatrix(r);
  r.align();

  const spread = r.ub(2);
  const interpolation = r.ub(2);
  const count = r.ub(4);
  const stops: GradientStop[] = [];
  for (let i = 0; i < count; i++) {
    stops.push({ ratio: r.u8(), color: readColor(r, alpha) });
  }

  const f = focal ? r.s16() : 0;
  return { matrix, spread, interpolation, stops, focal: f / 256 };
}

function readFill(r: SwfReader, version: number): Fill {
  const alpha = version >= 3;
  const type = r.u8();
  if (type === 0x00) {
    return { type: "solid", color: readColor(r, alpha) };
  }

  if (type === 0x10 || type === 0x12 || type === 0x13) {
    const kind = type === 0x10 ? "linear" : type === 0x12 ? "radial" : "focal";
    return { type: kind, gradient: readGradient(r, alpha, type === 0x13) };
  }

  // Bitmap fills 0x40 to 0x43: repeating or clipped, smoothed or not. Any
  // other type byte reads as one too, rather than failing the shape.
  const bitmap = r.u16();
  const matrix = readMatrix(r);
  return { type: "bitmap", bitmap, matrix, repeat: (type & 1) === 0, smooth: (type & 2) === 0 };
}

function readFills(r: SwfReader, version: number): Fill[] {
  let count = r.u8();
  if (count === 0xff && version >= 2) {
    count = r.u16();
  }

  const fills: Fill[] = [];
  for (let i = 0; i < count && !r.overrun; i++) {
    fills.push(readFill(r, version));
  }

  return fills;
}

/** A line of DefineShape to DefineShape3, or a MORPHLINESTYLE's start or end: round, its colour only. */
function plainLine(width: number, color: number): Line {
  return {
    width,
    color,
    startCap: 0,
    endCap: 0,
    join: 0,
    miterLimit: 3,
    noHScale: false,
    noVScale: false,
    pixelHinting: false,
    noClose: false,
    fill: null,
  };
}

/** LINESTYLE2's flags and miter limit, which MORPHLINESTYLE2 has too, before its fill or colour. */
function readLineFlags(
  r: SwfReader,
): Omit<Line, "width" | "color" | "fill"> & { hasFill: boolean } {
  const startCap = r.ub(2);
  const join = r.ub(2);
  const hasFill = r.ub(1) === 1;
  const noHScale = r.ub(1) === 1;
  const noVScale = r.ub(1) === 1;
  const pixelHinting = r.ub(1) === 1;

  r.ub(5); // reserved: the flags fill two bytes, must be zero

  const noClose = r.ub(1) === 1;
  const endCap = r.ub(2);
  const miterLimit = join === 2 ? r.u16() / 256 : 3;
  return { startCap, endCap, join, miterLimit, noHScale, noVScale, pixelHinting, noClose, hasFill };
}

/** The colour a filled line stands for where only a colour is read. */
function fillColor(fill: Fill): number {
  return fill.type === "solid"
    ? fill.color
    : fill.type === "bitmap"
      ? 0xff000000
      : (fill.gradient.stops[0]?.color ?? 0xff000000);
}

function readLines(r: SwfReader, version: number): Line[] {
  let count = r.u8();
  if (count === 0xff && version >= 2) {
    count = r.u16();
  }

  const lines: Line[] = [];
  for (let i = 0; i < count && !r.overrun; i++) {
    const width = r.u16();
    if (version < 4) {
      lines.push(plainLine(width, readColor(r, version >= 3)));
      continue;
    }

    const { hasFill, ...flags } = readLineFlags(r);
    const fill = hasFill ? readFill(r, version) : null;
    const color = fill ? fillColor(fill) : readColor(r, true);
    lines.push({ width, color, ...flags, fill });
  }

  return lines;
}

/** The records from the reader's position: fill and line bit counts first, then records to the end record. */
export function readRecords(
  r: SwfReader,
  version: number,
): { records: ShapeRecord[]; truncated: boolean } {
  r.align();
  let fillBits = r.ub(4);
  let lineBits = r.ub(4);
  const records: ShapeRecord[] = [];

  for (;;) {
    if (r.overrun) {
      return { records, truncated: true };
    }

    if (r.ub(1)) {
      // An edge.
      const straight = r.ub(1);
      const n = r.ub(4) + 2;
      if (straight) {
        const general = r.ub(1);
        const vertical = general ? 0 : r.ub(1);
        const dx = general || !vertical ? r.sb(n) : 0;
        const dy = general || vertical ? r.sb(n) : 0;
        records.push({ type: "line", dx, dy });
      } else {
        records.push({ type: "curve", cx: r.sb(n), cy: r.sb(n), ax: r.sb(n), ay: r.sb(n) });
      }

      continue;
    }

    const flags = r.ub(5);
    if (flags === 0) {
      return { records, truncated: false };
    }

    let moveTo: { x: number; y: number } | null = null;
    if (flags & 1) {
      const n = r.ub(5);
      moveTo = { x: r.sb(n), y: r.sb(n) };
    }

    const fill0 = flags & 2 ? r.ub(fillBits) : null;
    const fill1 = flags & 4 ? r.ub(fillBits) : null;
    const line = flags & 8 ? r.ub(lineBits) : null;
    let styles: { fills: Fill[]; lines: Line[] } | null = null;

    if (flags & 16 && version >= 2) {
      styles = { fills: readFills(r, version), lines: readLines(r, version) };
      r.align();
      fillBits = r.ub(4);
      lineBits = r.ub(4);
    }

    records.push({ type: "style", moveTo, fill0, fill1, line, styles });
  }
}

/** A DefineShape tag's body, of the version its code gives. */
export function readShape(bytes: Uint8Array, code: number, offset: number, length: number): Shape {
  const version =
    code === DefineShape ? 1 : code === DefineShape2 ? 2 : code === DefineShape3 ? 3 : 4;
  if (
    code !== DefineShape &&
    code !== DefineShape2 &&
    code !== DefineShape3 &&
    code !== DefineShape4
  ) {
    throw new Error(`tag ${code} is not a shape`);
  }

  const r = new SwfReader(bytes, offset, offset + length);
  const id = r.u16();
  const bounds = r.rect();

  let edgeBounds: Rect | null = null;
  if (version === 4) {
    edgeBounds = r.rect();
    r.u8();
  }

  const fills = readFills(r, version);
  const lines = readLines(r, version);
  const { records, truncated } = readRecords(r, version);
  return { id, bounds, edgeBounds, fills, lines, records, truncated };
}

/**
 * DefineMorphShape or DefineMorphShape2: a shape at two ends, which a
 * placement's ratio blends. Each fill and line is a pair, its start and its
 * end; the end's records have the start's edges in the same order and only
 * moves for style changes.
 */
export interface MorphShape {
  id: number;
  startBounds: Rect;
  endBounds: Rect;
  /** DefineMorphShape2's bounds without the lines' widths. */
  startEdgeBounds: Rect | null;
  endEdgeBounds: Rect | null;
  fills: { start: Fill; end: Fill }[];
  lines: { start: Line; end: Line }[];
  start: ShapeRecord[];
  end: ShapeRecord[];
  /** Whether either end's records ran past the tag's end. */
  truncated: boolean;
}

/** MORPHGRADIENT: both matrices, then each stop's start and end. */
function readMorphGradient(r: SwfReader, focal: boolean): { start: Gradient; end: Gradient } {
  const startMatrix = readMatrix(r);
  const endMatrix = readMatrix(r);

  // The count's byte carries spread and interpolation as a shape's
  // gradient's does, which Flash writes and reads alike.
  const spread = r.ub(2);
  const interpolation = r.ub(2);
  const count = r.ub(4);
  const startStops: GradientStop[] = [];
  const endStops: GradientStop[] = [];
  for (let i = 0; i < count; i++) {
    startStops.push({ ratio: r.u8(), color: readColor(r, true) });
    endStops.push({ ratio: r.u8(), color: readColor(r, true) });
  }

  const startFocal = focal ? r.s16() / 256 : 0;
  const endFocal = focal ? r.s16() / 256 : 0;
  return {
    start: { matrix: startMatrix, spread, interpolation, stops: startStops, focal: startFocal },
    end: { matrix: endMatrix, spread, interpolation, stops: endStops, focal: endFocal },
  };
}

function readMorphFill(r: SwfReader): { start: Fill; end: Fill } {
  const type = r.u8();
  if (type === 0x00) {
    return {
      start: { type: "solid", color: readColor(r, true) },
      end: { type: "solid", color: readColor(r, true) },
    };
  }

  if (type === 0x10 || type === 0x12 || type === 0x13) {
    const kind = type === 0x10 ? "linear" : type === 0x12 ? "radial" : "focal";
    const { start, end } = readMorphGradient(r, type === 0x13);
    return { start: { type: kind, gradient: start }, end: { type: kind, gradient: end } };
  }

  const bitmap = r.u16();
  const repeat = (type & 1) === 0;
  const smooth = (type & 2) === 0;
  return {
    start: { type: "bitmap", bitmap, matrix: readMatrix(r), repeat, smooth },
    end: { type: "bitmap", bitmap, matrix: readMatrix(r), repeat, smooth },
  };
}

function readMorphFills(r: SwfReader): { start: Fill; end: Fill }[] {
  let count = r.u8();
  if (count === 0xff) {
    count = r.u16();
  }

  const fills: { start: Fill; end: Fill }[] = [];
  for (let i = 0; i < count && !r.overrun; i++) {
    fills.push(readMorphFill(r));
  }

  return fills;
}

/**
 * MORPHLINESTYLE (version 1) or MORPHLINESTYLE2 (2): both widths, then colours, or flags and a
 * fill.
 */
function readMorphLines(r: SwfReader, version: number): { start: Line; end: Line }[] {
  let count = r.u8();
  if (count === 0xff) {
    count = r.u16();
  }

  const lines: { start: Line; end: Line }[] = [];
  for (let i = 0; i < count && !r.overrun; i++) {
    const startWidth = r.u16();
    const endWidth = r.u16();
    if (version < 2) {
      const startColor = readColor(r, true);
      lines.push({
        start: plainLine(startWidth, startColor),
        end: plainLine(endWidth, readColor(r, true)),
      });
      continue;
    }

    const { hasFill, ...flags } = readLineFlags(r);
    if (hasFill) {
      const fill = readMorphFill(r);
      lines.push({
        start: { width: startWidth, color: fillColor(fill.start), ...flags, fill: fill.start },
        end: { width: endWidth, color: fillColor(fill.end), ...flags, fill: fill.end },
      });
      continue;
    }

    const startColor = readColor(r, true);
    const endColor = readColor(r, true);
    lines.push({
      start: { width: startWidth, color: startColor, ...flags, fill: null },
      end: { width: endWidth, color: endColor, ...flags, fill: null },
    });
  }

  return lines;
}

/** A DefineMorphShape or DefineMorphShape2 tag's body, of the version its code gives. */
export function readMorphShape(
  bytes: Uint8Array,
  code: number,
  offset: number,
  length: number,
): MorphShape {
  if (code !== DefineMorphShape && code !== DefineMorphShape2) {
    throw new Error(`tag ${code} is not a morph shape`);
  }

  const version = code === DefineMorphShape ? 1 : 2;
  const r = new SwfReader(bytes, offset, offset + length);
  const id = r.u16();
  const startBounds = r.rect();
  const endBounds = r.rect();

  let startEdgeBounds: Rect | null = null;
  let endEdgeBounds: Rect | null = null;
  if (version === 2) {
    startEdgeBounds = r.rect();
    endEdgeBounds = r.rect();
    r.u8();
  }

  // The end's records are where the offset says, which may be past where
  // the start's end when a tool pads them.
  const endOffset = r.u32();
  const endAt = r.pos + endOffset;
  const fills = readMorphFills(r);
  const lines = readMorphLines(r, version);

  // The start's records stop at the end's, where the offset lies past the
  // styles and in the tag: one missing its end record reads no further. A
  // style change in either end's records brings no new styles: version 1
  // reads none.
  const offsetValid = endOffset !== 0 && endAt >= r.pos && endAt <= r.end;
  const start = readRecords(offsetValid ? new SwfReader(r.bytes, r.pos, endAt) : r, 1);
  if (offsetValid) {
    r.pos = endAt;
  }

  const end = readRecords(r, 1);
  return {
    id,
    startBounds,
    endBounds,
    startEdgeBounds,
    endEdgeBounds,
    fills,
    lines,
    start: start.records,
    end: end.records,
    truncated: start.truncated || end.truncated,
  };
}
