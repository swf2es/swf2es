// Keyboard input as Flash takes it, after Ruffle's (focus_tracker.rs,
// edit_text.rs): a key goes to the focused object, or the stage where
// nothing has focus, as a KeyboardEvent that bubbles; a focused input
// TextField then edits its text, a TextEvent first, which a listener may
// cancel, then Event.CHANGE. Focus moves with a click, with Tab, and with
// stage.focus, each move a focusOut and a focusIn; a click's and a Tab's
// first a cancelable mouseFocusChange or keyFocusChange.

import { bounds, toStage } from "./bounds.js";
import {
  ButtonObject,
  CONTENT,
  type Container,
  type DisplayObject,
  MovieClip,
  TextObject,
} from "./display.js";
import { apply } from "./geometry.js";
import { dispatchEvent } from "./playerglobal/flash/events/EventDispatcher.js";
import type { Scripting } from "./scripting.js";
import { GUTTER } from "./text-layout.js";

/** A key as the host gives it, in Flash's terms. */
export interface KeyState {
  keyCode: number;
  /** The character typed, 0 for none. */
  charCode: number;
  /** 0 standard, 1 left, 2 right, 3 numeric keypad. */
  location?: number;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

const BACKSPACE = 8;
const TAB = 9;
const ENTER = 13;
const END = 35;
const HOME = 36;
const LEFT = 37;
const UP = 38;
const RIGHT = 39;
const DOWN = 40;
const DELETE = 46;

/** Whether `d` takes typing: an input field. */
const editable = (d: DisplayObject | null): d is TextObject =>
  d instanceof TextObject && d.type === "input";

/** A display object's AS3 fields that focus reads. */
type Fields = {
  $tabEnabled?: boolean;
  $tabIndex?: number;
  $tabChildren?: boolean;
  $buttonMode?: boolean;
};

const fieldsOf = (d: DisplayObject): Fields => (d.object ?? {}) as Fields;

/**
 * Whether Tab may focus `d` where no script said: an input field, a
 * button, and a sprite in button mode, as Flash has it.
 */
export function tabEnabledDefault(d: DisplayObject): boolean {
  if (d instanceof TextObject) {
    return d.type === "input";
  }

  return d instanceof ButtonObject || !!fieldsOf(d).$buttonMode;
}

const tabEnabled = (d: DisplayObject): boolean => fieldsOf(d).$tabEnabled ?? tabEnabledDefault(d);

/** Whether `d` is an InteractiveObject's face: a container, a button or a field. */
const isInteractive = (d: DisplayObject): boolean =>
  d instanceof ButtonObject || d instanceof TextObject || "children" in d;

/** Whether Tab visits `d`: a field only where it takes typing, a root clip never. */
function tabbable(d: DisplayObject, stage: Container): boolean {
  if (!d.object || !isInteractive(d)) {
    return false;
  }

  if (d instanceof TextObject) {
    return d.type === "input" && tabEnabled(d);
  }

  return !(d instanceof MovieClip && d.parent === stage) && tabEnabled(d);
}

/** Whether a click focuses `d`: any text field, any object Tab may focus. */
const focusableByMouse = (d: DisplayObject): boolean => d instanceof TextObject || tabEnabled(d);

/**
 * Move focus to `next`: focusOut on the one that had it, then focusIn on
 * it, each naming the other, unless a focusOut listener moved it on; a
 * field gains or loses its caret, and the object a hook to give it up by
 * when it is taken off the list or hidden.
 */
export function setFocus(s: Scripting, next: DisplayObject | null): void {
  const previous = s.focus;
  if (previous === next) {
    return;
  }

  s.focus = next;
  if (previous) {
    previous.focusDrop = null;
  }

  if (next) {
    next.focusDrop = (d) => {
      if (s.focus === d) {
        setFocus(s, null);
      }
    };
  }

  for (const d of [previous, next]) {
    if (d instanceof TextObject) {
      d.focused = d === next;
      d.invalidate(CONTENT);
    }
  }

  if (previous) {
    focusEvent(s, "focusOut", previous, next, false);
  }

  if (next && s.focus === next) {
    focusEvent(s, "focusIn", next, previous, false);
  }
}

/** A FocusEvent on `target`, naming `related`: whether a listener cancelled it. */
function focusEvent(
  s: Scripting,
  type: string,
  target: DisplayObject,
  related: DisplayObject | null,
  cancelable: boolean,
  keyCode = 0,
): boolean {
  if (!target.object) {
    return false;
  }

  const event = s.rt.construct(
    s.rt.classNamed("flash.events::FocusEvent"),
    type,
    true,
    cancelable,
    related?.object ?? null,
    false,
    keyCode,
  );
  dispatchEvent(s, target.object, event);
  return !!event.$prevented;
}

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

/** The keyboard on the player's display list, independent of a renderer. */
export class KeyboardInput {
  /** How many key events it has handled: each may run scripts and change a field. */
  handled = 0;
  /** The field the pointer was pressed on, where, and by which click, whose selection a drag extends. */
  private press: { field: TextObject; position: number; clicks: number } | null = null;

  constructor(
    private readonly stage: Container,
    private readonly scripting: Scripting,
  ) {}

  /**
   * A key pressed or let go: whether the SWF used it, a field's edit or
   * caret, or Tab moving focus, which a host then keeps from the browser.
   */
  handle(type: "down" | "up", k: KeyState): boolean {
    this.handled++;
    const s = this.scripting;
    const target = s.focus && onStage(s.focus, this.stage) ? s.focus : this.stage;
    if (target.object) {
      const event = s.rt.construct(
        s.rt.classNamed("flash.events::KeyboardEvent"),
        type === "down" ? "keyDown" : "keyUp",
        true,
        false,
        k.charCode,
        k.keyCode,
        k.location ?? 0,
        !!k.ctrlKey,
        !!k.altKey,
        !!k.shiftKey,
      );
      dispatchEvent(s, target.object, event);
    }

    if (type !== "down") {
      return false;
    }

    if (k.keyCode === TAB) {
      return this.tab(!!k.shiftKey);
    }

    if (editable(s.focus) && onStage(s.focus, this.stage)) {
      return this.edit(s.focus, k);
    }

    return false;
  }

  /**
   * A press on `target`, with the point in its own pixels: as Flash, a
   * cancelable mouseFocusChange on what has focus, or the stage, then
   * focus to the target where a click focuses it, else to nothing; a
   * field's caret where it was clicked.
   */
  pressed(target: DisplayObject | null, localX: number, localY: number, clicks = 1): void {
    const s = this.scripting;
    const pressed = target === this.stage ? null : target;
    this.press = null;
    if (pressed instanceof TextObject && pressed.selectable) {
      const position = caretAt(pressed, localX * 20, localY * 20);
      this.press = { field: pressed, position, clicks };
      const [from, to] = selectionAt(pressed, position, clicks);
      pressed.select(from, to);
    }

    if (pressed === null && !(s.focus && focusableByMouse(s.focus))) {
      return;
    }

    if (pressed === s.focus) {
      return;
    }

    if (focusEvent(s, "mouseFocusChange", s.focus ?? this.stage, pressed, true)) {
      return;
    }

    setFocus(s, pressed && focusableByMouse(pressed) ? pressed : null);
  }
  /**
   * The pointer moved with its button held, the point in the pressed
   * field's own pixels: the selection spans from where the press was to
   * here, by characters, or by words or lines after a double or triple click.
   */
  dragged(field: TextObject, localX: number, localY: number): void {
    const press = this.press;
    if (!press || press.field !== field || !field.selectable) {
      return;
    }

    const [startFrom, startTo] = selectionAt(field, press.position, press.clicks);
    const [from, to] = selectionAt(field, caretAt(field, localX * 20, localY * 20), press.clicks);
    if (from < startFrom) {
      field.select(startTo, from);
    } else {
      field.select(startFrom, Math.max(to, startTo));
    }
  }

  /**
   * Tab: the next object Tab visits, or with Shift the one before, after a
   * cancelable keyFocusChange: by tabIndex where any has one, only those
   * then, else by where their bounds start on the stage, 6y + x in twips,
   * one of each place, as Flash orders them.
   */
  private tab(back: boolean): boolean {
    const found: DisplayObject[] = [];
    const walk = (d: DisplayObject) => {
      for (const child of (d as Container).children ?? []) {
        if (!child.visible) {
          continue;
        }

        if (tabbable(child, this.stage)) {
          found.push(child);
        }

        if ("children" in child && fieldsOf(child).$tabChildren !== false) {
          walk(child);
        }
      }
    };
    walk(this.stage);

    const indexed = found.filter((d) => (fieldsOf(d).$tabIndex ?? -1) >= 0);
    let order: DisplayObject[];
    if (indexed.length > 0) {
      order = indexed
        .map((d, i) => ({ d, i, key: fieldsOf(d).$tabIndex ?? 0 }))
        .sort((a, b) => a.key - b.key || a.i - b.i)
        .map((e) => e.d);
    } else {
      const keyed = found.map((d, i) => ({ d, i, key: placeKey(d, this.stage) }));
      keyed.sort((a, b) => a.key - b.key || a.i - b.i);
      order = keyed.filter((e, j) => j === 0 || e.key !== keyed[j - 1].key).map((e) => e.d);
    }

    if (order.length === 0) {
      return false;
    }

    const s = this.scripting;
    const at = s.focus ? order.indexOf(s.focus) : -1;
    const n = order.length;
    const next = order[at < 0 ? (back ? n - 1 : 0) : (at + (back ? -1 : 1) + n) % n];
    if (!focusEvent(s, "keyFocusChange", s.focus ?? this.stage, next, true, TAB)) {
      setFocus(s, next);
    }

    return true;
  }

  /** A key's edit of the focused field: a character typed, a deletion, or the caret moved. */
  private edit(field: TextObject, k: KeyState): boolean {
    const length = field.model.text.length;
    const [begin, end] = field.selection;
    const caret = field.caret;
    // Ctrl with Alt is AltGr on some layouts, which types characters.
    const shortcut = !!k.ctrlKey && !k.altKey;
    if (shortcut && (k.keyCode === 65 || k.charCode === 97 || k.charCode === 65)) {
      field.select(0, length);
      return true;
    }

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
        : k.charCode >= 32
          ? String.fromCharCode(k.charCode)
          : "";
    return text !== "" && this.type(field, text);
  }

  /**
   * Typed text, as Ruffle takes it: nothing where maxChars leaves no room;
   * else the TextEvent with the text as typed, a line break as "\n",
   * which a listener may cancel, then what restrict lets through, cut to
   * the room left, over the selection, and Event.CHANGE.
   */
  private type(field: TextObject, text: string): boolean {
    const room = () => {
      const [b, e] = field.selection;
      return field.maxChars > 0 ? field.maxChars - (field.model.text.length - (e - b)) : Infinity;
    };
    if (room() <= 0) {
      return true;
    }

    const filtered = restrictText(field.restrict, text);
    const s = this.scripting;
    if (field.object) {
      const event = s.rt.construct(
        s.rt.classNamed("flash.events::TextEvent"),
        "textInput",
        true,
        true,
        text.replace(/\r/g, "\n"),
      );
      dispatchEvent(s, field.object, event);
      if (event.$prevented) {
        return true;
      }
    }

    // The selection as the listeners left it, the text perhaps changed.
    const [begin, end] = field.selection;
    this.replace(field, begin, end, filtered.slice(0, Math.max(0, room())));
    return true;
  }

  /** [from, to) of the field's text as `text`, the caret after it, and Event.CHANGE. */
  private replace(field: TextObject, from: number, to: number, text: string): void {
    field.model.replace(from, to, text);
    field.select(from + text.length, from + text.length);
    field.invalidate(CONTENT);
    const s = this.scripting;
    if (field.object) {
      dispatchEvent(
        s,
        field.object,
        s.rt.construct(s.rt.classNamed("flash.events::Event"), "change", true, false),
      );
    }
  }
}

/** Where `d`'s bounds start on the stage, as Flash orders Tab: 6y + x, in twips. */
function placeKey(d: DisplayObject, stage: Container): number {
  const r = bounds(d, true);
  const [x, y] = r ? apply(toStage(d, stage), r.xMin, r.yMin) : [0, 0];
  return Math.round(y * 20) * 6 + Math.round(x * 20);
}

/** The caret one line up (-1) or down (1) from `caret`, at the same x, or the text's start or end past the first or last. */
function lineMove(field: TextObject, caret: number, by: -1 | 1): number {
  const lines = field.layout.lines;
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

/** Whether `d` is on the display list under `stage`. */
function onStage(d: DisplayObject, stage: Container): boolean {
  for (let p: DisplayObject | null = d; p; p = p.parent) {
    if (p === stage) {
      return true;
    }
  }

  return false;
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
function selectionAt(field: TextObject, position: number, clicks: number): [number, number] {
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

/** Flash's key codes where a browser's legacy ones differ: Firefox's for ";", "=" and "-". */
const KEY_CODES: Record<number, number> = { 59: 186, 61: 187, 173: 189 };

/** The character a browser's key types, as Flash's charCode: its UTF-16 unit, or Enter's, Backspace's, Tab's, Escape's and Delete's. */
function charCodeOf(e: KeyboardEvent): number {
  if (e.key.length === 1) {
    return e.key.charCodeAt(0);
  }

  return { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 127 }[e.key] ?? 0;
}

/**
 * Send the browser's keys on `target` (the window, say) to the player. A
 * key goes to the SWF unless it is typed into the page's own input or
 * button, or comes from an IME, which the player cannot compose; the
 * browser is kept from acting on one only where the SWF used it: a field's
 * edit or caret, or Tab moving the SWF's focus. Its own shortcuts stay.
 */
export function bindKeyboard(
  player: { keyboard: KeyboardInput | null; scripting: Scripting | null },
  target: EventTarget,
): () => void {
  const listener = (event: Event) => {
    const e = event as KeyboardEvent;
    const into = e.target as HTMLElement | null;
    if (
      into?.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(into?.tagName ?? "") ||
      e.isComposing ||
      e.keyCode === 229
    ) {
      return;
    }

    const keyboard = player.keyboard;
    if (!keyboard) {
      return;
    }

    const used = keyboard.handle(e.type === "keydown" ? "down" : "up", {
      keyCode: KEY_CODES[e.keyCode] ?? e.keyCode,
      charCode: charCodeOf(e),
      location: e.location,
      ctrlKey: e.ctrlKey || e.metaKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
    });
    if (used) {
      e.preventDefault();
    }
  };
  target.addEventListener("keydown", listener);
  target.addEventListener("keyup", listener);
  return () => {
    target.removeEventListener("keydown", listener);
    target.removeEventListener("keyup", listener);
  };
}
