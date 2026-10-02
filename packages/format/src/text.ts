// The editable text character a SWF places on its timeline.
import { readString, utf8 } from "./display.js";
import { type Rect, SwfReader, type Tag } from "./swf.js";

export interface EditText {
  id: number;
  bounds: Rect;
  variable: string;
  text: string;
  color: number | null;
  fontId: number | null;
  fontClass: string | null;
  fontHeight: number | null;
  align: number;
  leftMargin: number;
  rightMargin: number;
  indent: number;
  leading: number;
  maxLength: number | null;
  wordWrap: boolean;
  multiline: boolean;
  password: boolean;
  readOnly: boolean;
  autoSize: boolean;
  selectable: boolean;
  border: boolean;
  html: boolean;
  useOutlines: boolean;
}

/** DefineEditText (tag 37), including every conditional field before its variable and text. */
export function readEditText(bytes: Uint8Array, tag: Tag): EditText {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const id = r.u16();
  const bounds = r.rect();
  const flags = r.u8();
  const flags2 = r.u8();
  const hasText = (flags & 0x80) !== 0;
  const hasFont = (flags & 0x01) !== 0;
  const hasFontClass = (flags2 & 0x80) !== 0;
  const fontId = hasFont ? r.u16() : null;
  const fontClass = hasFontClass ? readString(r) : null;
  const fontHeight = hasFont || hasFontClass ? r.u16() : null;
  const color = flags & 0x04 ? r.u32() : null;
  const maxLength = flags & 0x02 ? r.u16() : null;
  let align = 0;
  let leftMargin = 0;
  let rightMargin = 0;
  let indent = 0;
  let leading = 0;
  if (flags2 & 0x20) {
    align = r.u8();
    leftMargin = r.u16();
    rightMargin = r.u16();
    indent = r.u16();
    leading = r.s16();
  }

  return {
    id,
    bounds,
    variable: readString(r),
    text: hasText ? readString(r) : "",
    color,
    fontId,
    fontClass,
    fontHeight,
    align,
    leftMargin,
    rightMargin,
    indent,
    leading,
    maxLength,
    wordWrap: (flags & 0x40) !== 0,
    multiline: (flags & 0x20) !== 0,
    password: (flags & 0x10) !== 0,
    readOnly: (flags & 0x08) !== 0,
    autoSize: (flags2 & 0x40) !== 0,
    selectable: (flags2 & 0x10) === 0,
    border: (flags2 & 0x08) !== 0,
    html: (flags2 & 0x02) !== 0,
    useOutlines: (flags2 & 0x01) !== 0,
  };
}

/** A DefineFont2 or DefineFont3's name and style: what a field in it shows its text in, the glyphs left. */
export interface FontName {
  id: number;
  name: string;
  bold: boolean;
  italic: boolean;
}

/** DefineFont2 (48) or DefineFont3 (75): the id, flags, language, then the name, a length-prefixed string. */
export function readFontName(bytes: Uint8Array, tag: Tag): FontName {
  const r = new SwfReader(bytes, tag.offset, tag.offset + tag.length);
  const id = r.u16();
  const flags = r.u8();
  r.u8();
  const length = r.u8();
  const start = r.pos;
  let end = Math.min(start + length, r.end);
  // A trailing NUL, which some tools write, is no part of the name.
  while (end > start && bytes[end - 1] === 0) {
    end--;
  }

  const name = utf8(bytes.subarray(start, end));
  return { id, name, bold: (flags & 0x01) !== 0, italic: (flags & 0x02) !== 0 };
}
