// Text editing shared by AVM1 and AVM2; each supplies its own notifications.
// After Ruffle's edit_text.rs and EditTextRestrict (https://github.com/ruffle-rs/ruffle):
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
import { CONTENT, type TextObject } from "../display/display.js";
import { GUTTER } from "../text/layout.js";
import type { KeyState } from "./keyboard.js";

const BACKSPACE = 8;
const ENTER = 13;
const END = 35;
const HOME = 36;
const LEFT = 37;
const UP = 38;
const RIGHT = 39;
const DOWN = 40;
const DELETE = 46;

/**
 * The characters `text` is typed as under `restrict`, as Ruffle parses it
 * (EditTextRestrict): null any; empty none; characters and ranges allowed,
 * each `^` switching to those disallowed and back, a leading one first
 * allowing all; `-` a range, from U+0000 where nothing is before it, its
 * first character alone where nothing follows or it runs backwards; `\`
 * the next character as itself. A letter it refuses is tried in the other
 * case, ASCII only.
 */
export function restrictText(restrict: string | null, text: string): string {
  if (restrict === null) {
    return text;
  }

  const { allowed, disallowed } = parseRestrict(restrict);
  const ok = (c: string) =>
    allowed.some(([a, b]) => c >= a && c <= b) && !disallowed.some(([a, b]) => c >= a && c <= b);
  let out = "";
  for (const c of text) {
    const candidates = [
      c,
      /[a-z]/.test(c) ? c.toUpperCase() : c,
      /[A-Z]/.test(c) ? c.toLowerCase() : c,
    ];
    const chosen = candidates.find(ok);
    if (chosen !== undefined) {
      out += chosen;
    }
  }

  return out;
}

type Interval = [string, string];

function parseRestrict(restrict: string): { allowed: Interval[]; disallowed: Interval[] } {
  const allowed: Interval[] = [];
  const disallowed: Interval[] = [];
  if (restrict === "") {
    return { allowed, disallowed };
  }

  // Tokens: a character, or "-" and "^" unescaped; a trailing "\" is dropped.
  const tokens: (string | { op: "-" | "^" })[] = [];
  const chars = [...restrict];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "\\") {
      if (i + 1 < chars.length) {
        tokens.push(chars[++i]);
      }
    } else if (c === "-" || c === "^") {
      tokens.push({ op: c });
    } else {
      tokens.push(c);
    }
  }

  let current: Interval[] = [];
  let last: string | null = null;
  let allowing = true;
  while (tokens.length > 0) {
    const t = tokens.shift() as string | { op: "-" | "^" };
    if (typeof t === "string") {
      current.push([t, t]);
      last = t;
      continue;
    }

    if (t.op === "^") {
      if (allowing) {
        if (current.length === 0 && allowed.length === 0) {
          allowed.push(["\0", "\u{10FFFF}"]);
        } else {
          allowed.push(...current);
        }
      } else {
        disallowed.push(...current);
      }

      current = [];
      allowing = !allowing;
      last = null;
      continue;
    }

    let start = "\0";
    if (last !== null) {
      current.pop();
      start = last;
    }

    let end = start;
    if (typeof tokens[0] === "string") {
      end = tokens.shift() as string;
    }

    current.push([start, end > start ? end : start]);
    last = null;
  }

  (allowing ? allowed : disallowed).push(...current);
  return { allowed, disallowed };
}

/** Edits a field, with the movie's input and change notifications. */
export class TextEditor {
  constructor(
    private readonly changed: (field: TextObject) => void,
    private readonly input?: (field: TextObject, text: string) => boolean,
  ) {}

  /**
   * A key's edit of the focused field: a character typed, a deletion, or
   * the caret moved; a selectable field that takes no typing moves its
   * caret and selection alone.
   */
  edit(field: TextObject, k: KeyState): boolean {
    const length = field.model.text.length;
    const [begin, end] = field.selection;
    const caret = field.caret;
    const shortcut = !!k.ctrlKey && !k.altKey;

    if (k.keyCode === UP || k.keyCode === DOWN) {
      const to = lineMove(field, caret, k.keyCode === UP ? -1 : 1);
      field.select(k.shiftKey ? field.anchor : to, to);
      return true;
    }

    if (k.keyCode === LEFT || k.keyCode === RIGHT || k.keyCode === HOME || k.keyCode === END) {
      const collapse = begin !== end && !k.shiftKey;
      const to =
        k.keyCode === HOME
          ? 0
          : k.keyCode === END
            ? length
            : k.keyCode === LEFT
              ? collapse
                ? begin
                : Math.max(0, caret - 1)
              : collapse
                ? end
                : Math.min(length, caret + 1);
      field.select(k.shiftKey ? field.anchor : to, to);
      return true;
    }

    if (field.type !== "input") {
      return false;
    }

    if (k.keyCode === BACKSPACE || k.keyCode === DELETE) {
      const from = begin !== end ? begin : k.keyCode === BACKSPACE ? Math.max(0, caret - 1) : caret;
      const to = begin !== end ? end : k.keyCode === DELETE ? Math.min(length, caret + 1) : caret;
      if (from < to) {
        this.replace(field, from, to, "");
      }

      return true;
    }

    if (shortcut) {
      return false;
    }

    const text =
      k.keyCode === ENTER
        ? field.multiline
          ? "\r"
          : ""
        : k.charCode >= 32 && k.charCode <= 0x10ffff
          ? String.fromCodePoint(k.charCode)
          : "";
    return text !== "" && this.type(field, text);
  }

  /**
   * Typed text, as Ruffle takes it: nothing where maxChars leaves no room;
   * else the input notification, which may cancel it, then what restrict
   * lets through, cut to the room left, over the selection, and the change notification.
   */
  type(field: TextObject, text: string): boolean {
    const room = () => {
      const [b, e] = field.selection;
      return field.maxChars > 0 ? field.maxChars - (field.model.text.length - (e - b)) : Infinity;
    };
    if (room() <= 0) {
      return true;
    }

    const filtered = restrictText(field.restrict, text);
    const [begin, end] = field.selection;
    if (this.input && !this.input(field, text)) {
      return true;
    }

    // The selection from before the event, within the text a listener may have shortened.
    const length = field.model.text.length;
    const from = Math.min(begin, length);
    this.replace(field, from, Math.min(end, length), filtered.slice(0, Math.max(0, room())));
    return true;
  }

  /** [from, to) of the field's text as `text`, the caret after it, and the change notification. */
  replace(field: TextObject, from: number, to: number, text: string): void {
    field.model.replace(from, to, text);
    field.select(from + text.length, from + text.length);
    field.invalidate(CONTENT);
    this.changed(field);
  }
}

/**
 * Pasted text as a field takes it, as Ruffle's text_input: its line breaks
 * as Flash's "\r", none at all in a single-line field, and no other
 * control characters.
 */
export function pasteable(multiline: boolean, text: string): string {
  const lines = text.replace(/\r\n?|\n/g, multiline ? "\r" : "");
  // A control character other than "\r".
  return lines.replace(/[^\P{Cc}\r]/gu, "");
}

/** The caret one line up (-1) or down (1) from `caret`, at the same x, or the text's start or end past the first or last. */
function lineMove(field: TextObject, caret: number, by: -1 | 1): number {
  const lines = field.layout.lines;
  if (lines.length === 0) {
    return 0;
  }

  const at = lines.findIndex((l) => caret < l.end);
  const i = at < 0 ? lines.length - 1 : at;
  const target = i + by;
  if (target < 0) {
    return 0;
  }

  if (target >= lines.length) {
    return field.model.text.length;
  }

  const line = lines[i];
  const c = line.chars[caret - line.start];
  const x = c ? c.x : line.x + line.width;
  const to = lines[target];
  for (const ch of to.chars) {
    if (ch.shown && x < ch.x + ch.advance / 2) {
      return ch.index;
    }
  }

  const text = field.model.text;
  return to.end > to.start && (text[to.end - 1] === "\r" || text[to.end - 1] === "\n")
    ? to.end - 1
    : to.end;
}

/** The caret index nearest (x, y), in twips in the field: the nearer side of the character there, or its line's end. */
export function caretAt(field: TextObject, x: number, y: number): number {
  const layout = field.layout;
  if (layout.lines.length === 0) {
    return 0;
  }

  const first = Math.min(Math.max(0, field.scrollV - 1), layout.lines.length - 1);
  const dy = field.top * 20 - (layout.lines[first].y - GUTTER);
  const dx = field.left * 20 - field.scrollH * 20;
  let line = layout.lines[layout.lines.length - 1];
  for (const l of layout.lines) {
    if (y < dy + l.y + l.ascent + l.descent) {
      line = l;
      break;
    }
  }

  for (const c of line.chars) {
    if (c.shown && x < dx + c.x + c.advance / 2) {
      return c.index;
    }
  }

  // Past the line's last character: before the newline that ends it, if any.
  const text = field.model.text;
  return line.end > line.start && (text[line.end - 1] === "\r" || text[line.end - 1] === "\n")
    ? line.end - 1
    : line.end;
}

const words = new Intl.Segmenter(undefined, { granularity: "word" });
const blank = (t: string): boolean => t.trim() === "";

/**
 * What a click at `position` selects, as Ruffle's: the point itself, a
 * double click's word, a triple click's line, from newline to newline.
 * A word stops at whitespace on either side of the point.
 */
export function selectionAt(field: TextObject, position: number, clicks: number): [number, number] {
  const text = field.model.text;
  if (clicks <= 1) {
    return [position, position];
  }

  if (clicks === 2) {
    const head = text.slice(0, position);
    let from = 0;
    if (head !== "" && blank(head[head.length - 1])) {
      from = position;
    } else {
      for (const w of words.segment(head)) {
        if (!blank(w.segment)) {
          from = w.index;
        }
      }
    }

    let to = text.length;
    const tail = text.slice(position);
    if (tail !== "" && blank(tail[0])) {
      to = position;
    } else {
      for (const w of words.segment(tail)) {
        if (!blank(w.segment)) {
          to = position + w.index + w.segment.length;
          break;
        }
      }
    }

    return [from, to];
  }

  const newline = (c: string) => c === "\r" || c === "\n";
  let from = position;
  while (from > 0 && !newline(text[from - 1])) {
    from--;
  }

  let to = position;
  while (to < text.length && !newline(text[to])) {
    to++;
  }

  return [from, to];
}
