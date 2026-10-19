// Send the VM's layout, not the inputs for laying it out again:
// script-visible metrics and the renderer's glyph positions must agree.
import { CONTENT } from "../../../packages/player/dist/display/displayobject.js";
import { TextObject } from "../../../packages/player/dist/display/textobjects.js";
import type { LaidChar, Line, TextLayout } from "../../../packages/player/dist/text/layout.js";
import { type CharFormat, DEFAULT_FORMAT } from "../../../packages/player/dist/text/text.js";
import type { SceneLibraries } from "./libraries.ts";
import { ValuesReader, ValuesWriter } from "./values.ts";

const PROPS = {
  left: 0,
  top: 0,
  width: 100,
  height: 100,
  border: false,
  borderColor: 0,
  background: false,
  backgroundColor: 0xffffff,
  scrollH: 0,
  scrollV: 1,
  antiAliasType: "normal",
  gridFitType: "pixel",
  sharpness: 0,
  thickness: 0,
  type: "dynamic",
  focused: false,
  selectable: true,
  displayAsPassword: false,
};
type Properties = typeof PROPS;
const READ_FIELDS = new WeakMap<object, [string, unknown][]>([
  [PROPS, Object.entries(PROPS)],
  [DEFAULT_FORMAT, Object.entries(DEFAULT_FORMAT)],
]);

function writeValues(w: ValuesWriter, values: object, schema: object): void {
  const record = values as Record<string, unknown>;
  for (const [key, sample] of Object.entries(schema)) {
    const value = record[key];
    if (Array.isArray(sample)) {
      const list = value as number[];
      w.number(list.length);
      for (const v of list) {
        w.number(v);
      }
    } else {
      switch (typeof sample) {
        case "number":
          w.number(value as number);
          break;
        case "boolean":
          w.number(Number(value));
          break;
        case "string":
          w.string(value as string);
          break;
      }
    }
  }
}

function readValues<T extends object>(r: ValuesReader, schema: T): T {
  const out: Record<string, unknown> = {};
  let fields = READ_FIELDS.get(schema);
  if (!fields) {
    fields = Object.entries(schema);
    READ_FIELDS.set(schema, fields);
  }
  for (let i = 0; i < fields.length; i++) {
    const [key, sample] = fields[i];
    if (Array.isArray(sample)) {
      const count = r.count();
      const list: number[] = [];
      for (let i = 0; i < count; i++) {
        list.push(r.number());
      }

      out[key] = list;
    } else {
      switch (typeof sample) {
        case "number":
          out[key] = r.number();
          break;
        case "boolean":
          out[key] = r.boolean();
          break;
        case "string":
          out[key] = r.string();
          break;
      }
    }
  }

  return out as T;
}

export function writeText(
  o: TextObject,
  data: Float64Array,
  at: number,
  assets: SceneLibraries,
): number {
  const w = new ValuesWriter(data, at);
  const layout = o.layout;
  const formats: CharFormat[] = [];
  const indices = new Map<CharFormat, number>();
  const format = (f: CharFormat) => {
    let index = indices.get(f);
    if (index === undefined) {
      index = formats.length;
      formats.push(f);
      indices.set(f, index);
    }

    return index;
  };
  format(o.model.defaultFormat);
  for (const f of o.model.formats) {
    format(f);
  }
  for (const line of layout.lines) {
    for (const c of line.chars) {
      format(c.format);
    }
  }

  writeValues(w, o, PROPS);
  w.number(o.anchor);
  w.number(o.caret);
  w.string(o.model.text);
  w.number(formats.length);
  for (const f of formats) {
    writeValues(w, f, DEFAULT_FORMAT);
  }

  w.number(o.model.formats.length);
  for (const f of o.model.formats) {
    w.number(format(f));
  }

  w.number(layout.width);
  w.number(layout.height);
  w.number(layout.lines.length);
  for (const line of layout.lines) {
    for (const v of [
      line.start,
      line.end,
      line.x,
      line.y,
      line.width,
      line.ascent,
      line.descent,
      line.leading,
      line.chars.length,
    ]) {
      w.number(v);
    }

    for (const c of line.chars) {
      const ref = c.font ? assets.ref(c.font) : null;
      for (const v of [
        c.index,
        c.x,
        c.at,
        c.advance,
        c.kern,
        Number(c.shown),
        format(c.format),
        ref?.library ?? 0,
        ref?.character ?? 0,
        c.font && c.glyph ? assets.glyph(c.font, c.glyph) : -1,
      ]) {
        w.number(v);
      }
    }
  }

  return w.at;
}

export interface TextRecord {
  properties: Properties;
  anchor: number;
  caret: number;
  text: string;
  defaultFormat: CharFormat;
  formats: CharFormat[];
  layout: TextLayout;
}

export function readText(
  data: Float64Array,
  at: number,
  assets: SceneLibraries,
): { record: TextRecord; end: number } {
  const r = new ValuesReader(data, at);
  const properties = readValues(r, PROPS);
  if (!Number.isSafeInteger(properties.scrollV)) {
    throw new Error("invalid scene snapshot text scroll");
  }

  const anchor = r.integer(0, Number.MAX_SAFE_INTEGER);
  const caret = r.integer(0, Number.MAX_SAFE_INTEGER);
  const text = r.string();
  if (anchor > text.length || caret > text.length) {
    throw new Error("invalid scene snapshot text selection");
  }

  const count = r.count();
  if (count === 0) {
    throw new Error("missing scene snapshot text format");
  }

  const pool: CharFormat[] = [];
  for (let i = 0; i < count; i++) {
    pool.push(readValues(r, DEFAULT_FORMAT));
  }

  const size = r.count();
  if (size !== text.length) {
    throw new Error("invalid scene snapshot text format count");
  }

  const formats: CharFormat[] = [];
  for (let i = 0; i < size; i++) {
    formats.push(pool[r.integer(0, pool.length - 1)]);
  }

  const width = r.number();
  const height = r.number();
  const lineCount = r.count();
  if (lineCount === 0) {
    throw new Error("missing scene snapshot text layout");
  }

  const lines: Line[] = [];
  for (let i = 0; i < lineCount; i++) {
    const start = r.integer(0, text.length);
    const end = r.integer(start, text.length);
    const x = r.number();
    const y = r.number();
    const width = r.number();
    const ascent = r.number();
    const descent = r.number();
    const leading = r.number();
    const count = r.count();
    if (count !== end - start) {
      throw new Error("invalid scene snapshot text line");
    }

    const chars: LaidChar[] = [];
    for (let k = 0; k < count; k++) {
      const index = r.integer(start + k, start + k);
      const x = r.number();
      const at = r.number();
      const advance = r.number();
      const kern = r.number();
      const shown = r.boolean();
      const format = pool[r.integer(0, pool.length - 1)];
      const library = r.integer(0, Number.MAX_SAFE_INTEGER);
      const character = r.integer(0, 65535);
      if (library === 0 && character !== 0) {
        throw new Error("invalid scene snapshot text font");
      }

      const font = library ? assets.font(library, character) : null;
      const glyph = r.integer(-1, font ? font.glyphs.length - 1 : -1);
      chars.push({
        index,
        x,
        at,
        advance,
        kern,
        shown,
        format,
        font,
        glyph: font && glyph >= 0 ? font.glyphs[glyph] : null,
      });
    }

    lines.push({ start, end, x, y, width, ascent, descent, leading, chars });
  }

  return {
    record: {
      properties,
      anchor,
      caret,
      text,
      defaultFormat: pool[0],
      formats,
      layout: { width, height, lines },
    },
    end: r.at,
  };
}

export class SnapshotText extends TextObject {
  private rendered!: TextLayout;

  constructor() {
    super(null);
  }

  override get layout(): TextLayout {
    return this.rendered;
  }

  apply(record: TextRecord): void {
    Object.assign(this, record.properties);
    this.model.defaultFormat = record.defaultFormat;
    this.model.setText(record.text);
    this.model.formats = record.formats;
    this.rendered = record.layout;
    this.select(record.anchor, record.caret);
    this.invalidate(CONTENT);
  }
}
