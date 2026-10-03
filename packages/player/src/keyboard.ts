// Keyboard input as Flash takes it: a key goes to the focused object, or
// the stage where nothing has focus, as a KeyboardEvent that bubbles; a
// focused input TextField then edits its text, a TextEvent first, which a
// listener may cancel, then Event.CHANGE. Focus moves with a click on an
// input field, with Tab among them, and with stage.focus, each move a
// focusOut and a focusIn.
import { CONTENT, type Container, type DisplayObject, TextObject } from "./display.js";
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
const RIGHT = 39;
const DELETE = 46;

/** Whether `field` takes typing: an input field, as only it shows a caret. */
const editable = (d: DisplayObject | null): d is TextObject =>
  d instanceof TextObject && d.type === "input";

/**
 * Move focus to `next`: focusOut on the one that had it, then focusIn on
 * it, each naming the other; a field gains or loses its caret.
 */
export function setFocus(s: Scripting, next: DisplayObject | null): void {
  const previous = s.focus;
  if (previous === next) {
    return;
  }

  s.focus = next;
  for (const d of [previous, next]) {
    if (d instanceof TextObject) {
      d.focused = d === next;
      d.invalidate(CONTENT);
    }
  }

  const focusEvent = (type: string, target: DisplayObject, related: DisplayObject | null) => {
    if (!target.object) {
      return;
    }

    const event = s.rt.construct(
      s.rt.classNamed("flash.events::FocusEvent"),
      type,
      true,
      false,
      related?.object ?? null,
    );
    dispatchEvent(s, target.object, event);
  };
  if (previous) {
    focusEvent("focusOut", previous, next);
  }

  if (next) {
    focusEvent("focusIn", next, previous);
  }
}

/**
 * Whether `restrict` lets `c` be typed, as TextField.restrict reads: null
 * any, a list of characters and ranges (`A-Z`), `^` excluding those after
 * it (all others allowed where it leads), `\` escaping the next.
 */
export function restricted(restrict: string | null, c: string): boolean {
  if (restrict === null) {
    return true;
  }

  let allowed = restrict.startsWith("^");
  let include = true;
  for (let i = 0; i < restrict.length; i++) {
    let ch = restrict[i];
    if (ch === "^") {
      include = !include;
      continue;
    }

    if (ch === "\\" && i + 1 < restrict.length) {
      ch = restrict[++i];
    }

    let last = ch;
    if (restrict[i + 1] === "-" && i + 2 < restrict.length) {
      last =
        restrict[i + 2] === "\\" && i + 3 < restrict.length ? restrict[i + 3] : restrict[i + 2];
      i += restrict[i + 2] === "\\" ? 3 : 2;
    }

    if (c >= ch && c <= last) {
      allowed = include;
    }
  }

  return allowed;
}

/** The keyboard on the player's display list, independent of a renderer. */
export class KeyboardInput {
  /** How many key events it has handled: each may run scripts and change a field. */
  handled = 0;

  constructor(
    private readonly stage: Container,
    private readonly scripting: Scripting,
  ) {}

  handle(type: "down" | "up", k: KeyState): void {
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
      return;
    }

    if (k.keyCode === TAB) {
      this.tab(!!k.shiftKey);
    } else if (editable(s.focus) && onStage(s.focus, this.stage)) {
      this.edit(s.focus, k);
    }
  }

  /** A click: an input field takes focus, its caret where the click is; anything else takes it from a field. */
  pressed(target: DisplayObject | null, localX: number, localY: number): void {
    const s = this.scripting;
    if (editable(target)) {
      setFocus(s, target);
      const caret = caretAt(target, localX * 20, localY * 20);
      target.select(caret, caret);
      return;
    }

    if (s.focus instanceof TextObject) {
      setFocus(s, null);
    }
  }

  /**
   * Tab: the next input field on the stage, or with Shift the one before:
   * by tabIndex where a field has one, as Flash orders only those then,
   * else in reading order.
   */
  private tab(back: boolean): void {
    const fields: { field: TextObject; x: number; y: number }[] = [];
    const walk = (d: DisplayObject, x: number, y: number) => {
      if (!d.visible) {
        return;
      }

      const m = d.matrix;
      const [ox, oy] = [x + m.tx, y + m.ty];
      if (editable(d)) {
        fields.push({ field: d, x: ox + d.left, y: oy + d.top });
      }

      for (const child of (d as Container).children ?? []) {
        walk(child, ox, oy);
      }
    };
    walk(this.stage, 0, 0);
    if (fields.length === 0) {
      return;
    }

    const tabIndex = (f: { field: TextObject }): number => f.field.object?.$tabIndex ?? -1;
    const indexed = fields.filter((f) => tabIndex(f) >= 0);
    const order = indexed.length > 0 ? indexed : fields;
    order.sort((a, b) => (indexed.length > 0 ? tabIndex(a) - tabIndex(b) : a.y - b.y || a.x - b.x));

    const n = order.length;
    const at = order.findIndex((f) => f.field === this.scripting.focus);
    const next = at < 0 ? (back ? n - 1 : 0) : (at + (back ? -1 : 1) + n) % n;
    const field = order[next].field;
    setFocus(this.scripting, field);
    field.select(0, field.model.text.length);
  }

  /** A key's edit of the focused field: a character typed, a deletion, or the caret moved. */
  private edit(field: TextObject, k: KeyState): void {
    const length = field.model.text.length;
    const [begin, end] = field.selection;
    const caret = field.caret;
    if (k.ctrlKey && (k.keyCode === 65 || k.charCode === 97)) {
      field.select(0, length);
      return;
    }

    if (k.keyCode === LEFT || k.keyCode === RIGHT || k.keyCode === HOME || k.keyCode === END) {
      const to =
        k.keyCode === HOME
          ? 0
          : k.keyCode === END
            ? length
            : k.keyCode === LEFT
              ? begin !== end && !k.shiftKey
                ? begin
                : Math.max(0, caret - 1)
              : begin !== end && !k.shiftKey
                ? end
                : Math.min(length, caret + 1);
      field.select(k.shiftKey ? field.anchor : to, to);
      return;
    }

    if (k.keyCode === BACKSPACE || k.keyCode === DELETE) {
      const from = begin !== end ? begin : k.keyCode === BACKSPACE ? Math.max(0, caret - 1) : caret;
      const to = begin !== end ? end : k.keyCode === DELETE ? Math.min(length, caret + 1) : caret;
      if (from < to) {
        this.replace(field, from, to, "");
      }

      return;
    }

    const text =
      k.keyCode === ENTER
        ? field.multiline
          ? "\r"
          : ""
        : k.ctrlKey || k.charCode < 32
          ? ""
          : String.fromCharCode(k.charCode);
    if (!text || (text !== "\r" && !restricted(field.restrict, text))) {
      return;
    }

    if (field.maxChars > 0 && length - (end - begin) + text.length > field.maxChars) {
      return;
    }

    // The TextEvent goes before the character, which a listener may prevent.
    const s = this.scripting;
    if (field.object) {
      const event = s.rt.construct(
        s.rt.classNamed("flash.events::TextEvent"),
        "textInput",
        true,
        true,
        text,
      );
      dispatchEvent(s, field.object, event);
      if (event.$prevented) {
        return;
      }
    }

    this.replace(field, begin, end, text);
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

/** The character a browser's key gives, as Flash's charCode: its text, or Enter's, Backspace's, Tab's, Escape's and Delete's. */
function charCodeOf(e: KeyboardEvent): number {
  if (e.key.length === 1) {
    return e.key.charCodeAt(0);
  }

  return { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 127 }[e.key] ?? 0;
}

/**
 * Send the browser's keys on `target` (the window, say) to the player. A
 * key goes to the game unless it is typed into the page's own input; while
 * a field of the game has focus, the browser does nothing more with it,
 * nor with Tab, which moves the game's focus.
 */
export function bindKeyboard(
  player: { keyboard: KeyboardInput | null; scripting: Scripting | null },
  target: EventTarget,
): () => void {
  const listener = (event: Event) => {
    const e = event as KeyboardEvent;
    const into = e.target as HTMLElement | null;
    if (into?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(into?.tagName ?? "")) {
      return;
    }

    const keyboard = player.keyboard;
    if (!keyboard) {
      return;
    }

    keyboard.handle(e.type === "keydown" ? "down" : "up", {
      keyCode: e.keyCode,
      charCode: charCodeOf(e),
      location: e.location,
      ctrlKey: e.ctrlKey || e.metaKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
    });
    if (e.key === "Tab" || editable(player.scripting?.focus ?? null)) {
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
