// Keyboard input as Flash takes it, after Ruffle's (focus_tracker.rs,
// edit_text.rs): a key goes to the focused object, or the stage where
// nothing has focus, as a KeyboardEvent that bubbles; a focused input
// TextField then edits its text, a TextEvent first, which a listener may
// cancel, then Event.CHANGE. Focus moves with a click, with Tab, and with
// stage.focus, each move a focusOut and a focusIn; a click's and a Tab's
// first a cancelable mouseFocusChange or keyFocusChange.

import { bounds, toStage } from "../display/bounds.js";
import {
  ButtonObject,
  CONTENT,
  Container,
  type DisplayObject,
  MovieClip,
  TextObject,
} from "../display/display.js";
import { apply } from "../display/geometry.js";
import type { ClipboardText } from "../hosts.js";
import { TEXT } from "../scripting/clipboard.js";
import { dispatchEvent } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import { caretAt, pasteable, selectionAt, TextEditor } from "./text-editor.js";

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

const TAB = 9;

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
  return !dispatchEvent(s, target.object, event);
}

export { restrictText } from "./text-editor.js";

/**
 * The keyboard as a host drives it (bindKeyboard, and the corpus's input
 * replay): an AS3 movie's KeyboardInput, or an AVM1 movie's
 * (avm1/keyboard.ts), whose keys go to Key, buttons and clips.
 */
export interface Keyboard {
  /** How many key events it has handled: each may run scripts and change what is drawn. */
  readonly handled: number;
  /** A key pressed or let go; without `edits`, its events alone. Whether the SWF used it. */
  handle(type: "down" | "up", k: KeyState, edits?: boolean): boolean;
  /** Text typed, or a field's editing key, with no key events. Whether the SWF used it. */
  text(k: KeyState): boolean;
  /** A copy or cut: what goes to the system's clipboard, or null for nothing. */
  copy(cut?: boolean): ClipboardText | null;
  /** A paste of the system's clipboard. Whether the SWF used it. */
  paste(data?: ClipboardText | null): boolean;
}

/** The keyboard on the player's display list, independent of a renderer. */
export class KeyboardInput implements Keyboard {
  /** How many key events it has handled: each may run scripts and change a field. */
  handled = 0;
  /** The field the pointer was pressed on, where, and by which click, whose selection a drag extends. */
  private press: { field: TextObject; position: number; clicks: number } | null = null;

  private readonly editor = new TextEditor(
    (field) => {
      if (field.object) {
        dispatchEvent(
          this.scripting,
          field.object,
          this.scripting.rt.construct(
            this.scripting.rt.classNamed("flash.events::Event"),
            "change",
            true,
            false,
          ),
        );
      }
    },
    (field, text) =>
      !field.object ||
      dispatchEvent(
        this.scripting,
        field.object,
        this.scripting.rt.construct(
          this.scripting.rt.classNamed("flash.events::TextEvent"),
          "textInput",
          true,
          true,
          text.replace(/\r/g, "\n"),
        ),
      ),
  );

  constructor(
    private readonly stage: Container,
    private readonly scripting: Scripting,
  ) {}

  /**
   * A key pressed or let go: whether the SWF used it, a field's edit or
   * caret, or Tab moving focus, which a host then keeps from the browser.
   * Without `edits`, it sends the key's events and moves focus, and edits
   * nothing, for a host whose text comes apart from its keys (`text`).
   */
  handle(type: "down" | "up", k: KeyState, edits = true): boolean {
    this.handled++;
    // A key is a user's gesture, in whose handlers a script may write to the clipboard.
    return this.scripting.clipboard.gesture(() => this.key(type, k, edits));
  }

  /**
   * Text typed, or a field's editing key (Backspace, an arrow, Ctrl+A),
   * with no key events: the field with focus edits by it as by its key.
   * Whether a field used it.
   */
  text(k: KeyState): boolean {
    this.handled++;
    // A user's gesture, as a key is: a listener may write to the clipboard.
    return this.scripting.clipboard.gesture(() => {
      const focus = this.focused();
      if (k.ctrlKey && !k.altKey && k.keyCode === 65) {
        return this.selectAll(focus);
      }

      return focus instanceof TextObject && (focus.type === "input" || focus.selectable)
        ? this.editor.edit(focus, k)
        : false;
    });
  }

  private key(type: "down" | "up", k: KeyState, edits: boolean): boolean {
    const s = this.scripting;
    const focus = this.focused();
    const target = focus ?? this.stage;
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

    if (!edits) {
      return false;
    }

    // Ctrl with Alt is AltGr on some layouts, which types characters.
    if (k.ctrlKey && !k.altKey && (k.keyCode === 65 || k.charCode === 97 || k.charCode === 65)) {
      return this.selectAll(focus);
    }

    if (focus instanceof TextObject && (focus.type === "input" || focus.selectable)) {
      return this.editor.edit(focus, k);
    }

    return false;
  }

  /** What has focus, while it is on the stage. */
  private focused(): DisplayObject | null {
    const focus = this.scripting.focus;
    return focus && onStage(focus, this.stage) ? focus : null;
  }

  /**
   * Ctrl+A: a text field selects all its text, if selectable; any other
   * object with focus hears Event.SELECT_ALL, as Flash 10 tells an
   * InteractiveObject, though never a TextField. Whether the player used it.
   */
  private selectAll(focus: DisplayObject | null): boolean {
    if (focus instanceof TextObject) {
      if (focus.selectable) {
        focus.select(0, focus.model.text.length);
      }

      return true;
    }

    return this.dispatchClipboard(focus, "selectAll");
  }

  /**
   * A copy, Ctrl+C, or a cut, Ctrl+X, as the host's copy or cut event has
   * it: the text field with focus copies its selection, but not a
   * password's, and an input field's cut deletes it after, with
   * Event.CHANGE, as Ruffle's does; any other object with focus hears
   * Event.COPY or Event.CUT, in which a script may write the clipboard.
   * What goes to the system's clipboard, or null for nothing.
   */
  copy(cut = false): ClipboardText | null {
    this.handled++;
    const s = this.scripting;
    const focus = this.focused();
    if (!(focus instanceof TextObject)) {
      return s.clipboard.collect(() => this.dispatchClipboard(focus, cut ? "cut" : "copy"));
    }

    const [from, to] = focus.selection;
    if (focus.displayAsPassword || from === to || (cut && focus.type !== "input")) {
      return null;
    }

    // Flash's line breaks are "\r", a browser's "\n".
    const text = focus.model.text.slice(from, to).replace(/\r\n?/g, "\n");
    return s.clipboard.collect(() => {
      s.clipboard.clear();
      s.clipboard.set(TEXT, text);
      if (cut) {
        this.editor.replace(focus, from, to, "");
      }
    });
  }

  /**
   * A paste, Ctrl+V, of `data` from the system's clipboard, or of what the
   * SWF last put there where the host gives none: an input field with
   * focus takes the text as if typed, a TextEvent first, but its line
   * breaks only if multiline, and nothing where the clipboard is empty, as
   * Ruffle's does; any other object with focus hears Event.PASTE, which
   * bubbles, and in which alone a script may read the clipboard. Whether
   * the player used it.
   */
  paste(data: ClipboardText | null = null): boolean {
    this.handled++;
    const s = this.scripting;
    const focus = this.focused();
    if (!(focus instanceof TextObject)) {
      return s.clipboard.paste(data, () => this.dispatchClipboard(focus, "paste"));
    }

    if (focus.type !== "input") {
      return false;
    }

    return s.clipboard.paste(data, () => {
      const text = pasteable(focus.multiline, s.clipboard.data.text);
      if (text !== "") {
        this.editor.type(focus, text);
      }

      return true;
    });
  }

  /** Event.COPY, CUT, PASTE or SELECT_ALL to what has focus, if a script made it: whether one heard it. */
  private dispatchClipboard(focus: DisplayObject | null, type: string): boolean {
    if (!focus?.object || !isInteractive(focus)) {
      return false;
    }

    const s = this.scripting;
    // Flash Player's paste bubbles; AIR's, and the others, do not.
    const event = s.rt.construct(
      s.rt.classNamed("flash.events::Event"),
      type,
      type === "paste",
      false,
    );
    dispatchEvent(s, focus.object, event);
    return true;
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

        // A SimpleButton's states are not its children to AS3.
        if (
          child instanceof Container &&
          !(child instanceof ButtonObject) &&
          fieldsOf(child).$tabChildren !== false
        ) {
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
}

/** Where `d`'s bounds start on the stage, as Flash orders Tab: 6y + x, in twips. */
function placeKey(d: DisplayObject, stage: Container): number {
  const r = bounds(d, true);
  const [x, y] = r ? apply(toStage(d, stage), r.xMin, r.yMin) : [0, 0];
  return Math.round(y * 20) * 6 + Math.round(x * 20);
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

/** Flash's key codes where a browser's legacy ones differ: Firefox's for ";", "=" and "-". */
const KEY_CODES: Record<number, number> = { 59: 186, 61: 187, 173: 189 };
const SCROLL_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  " ",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

/** The character a browser's key types, as Flash's charCode: its UTF-16 unit, or Enter's, Backspace's, Tab's, Escape's and Delete's. */
function charCodeOf(e: KeyboardEvent): number {
  if (e.key.length === 1) {
    return e.key.charCodeAt(0);
  }

  return { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 127 }[e.key] ?? 0;
}

/** Whether a browser event is the page's own: typed into its input or button, or editable content. */
function pagesOwn(e: Event): boolean {
  const into = e.target as HTMLElement | null;
  return (
    !!into?.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(into?.tagName ?? "")
  );
}

/**
 * Send the browser's keys on `target` (the window, say) to the player. A
 * key goes to the SWF unless it is typed into the page's own input or
 * button, or comes from an IME, which the player cannot compose; the
 * browser is kept from acting on a field's edit or caret, Tab moving the
 * SWF's focus, or a scrolling key meant for the SWF. Its shortcuts stay.
 * The copy, cut and paste events the browser sends for Ctrl+C, X and V,
 * or its menu's, go to the player too, which reads and writes the
 * clipboard through them, synchronously and without asking for leave.
 */
export function bindKeyboard(
  player: {
    keyboard: Keyboard | null;
    pointer?: { flush(): void } | null;
    touch?: { flush(): void } | null;
  },
  target: EventTarget,
): () => void {
  const listener = (event: Event) => {
    const e = event as KeyboardEvent;
    if (pagesOwn(e) || e.isComposing || e.keyCode === 229) {
      return;
    }

    const keyboard = player.keyboard;
    if (!keyboard) {
      return;
    }

    // A key's listeners see the pointer and the touches where they last moved.
    player.pointer?.flush();
    player.touch?.flush();

    const used = keyboard.handle(e.type === "keydown" ? "down" : "up", {
      keyCode: KEY_CODES[e.keyCode] ?? e.keyCode,
      charCode: charCodeOf(e),
      location: e.location,
      ctrlKey: e.ctrlKey || e.metaKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
    });
    if (used || (!e.ctrlKey && !e.metaKey && !e.altKey && SCROLL_KEYS.has(e.key))) {
      e.preventDefault();
    }
  };
  const clipboard = (event: Event) => {
    const e = event as ClipboardEvent;
    const keyboard = player.keyboard;
    if (pagesOwn(e) || !keyboard) {
      return;
    }

    const transfer = e.clipboardData;
    if (e.type === "paste") {
      const html = transfer?.getData("text/html");
      const data = transfer
        ? { text: transfer.getData("text/plain"), ...(html ? { html } : {}) }
        : null;
      if (keyboard.paste(data)) {
        e.preventDefault();
      }

      return;
    }

    const data = keyboard.copy(e.type === "cut");
    if (data && transfer) {
      transfer.setData("text/plain", data.text);
      if (data.html !== undefined) {
        transfer.setData("text/html", data.html);
      }

      e.preventDefault();
    }
  };
  const types = ["keydown", "keyup"] as const;
  const clipboardTypes = ["copy", "cut", "paste"] as const;
  for (const type of types) {
    target.addEventListener(type, listener);
  }

  for (const type of clipboardTypes) {
    target.addEventListener(type, clipboard);
  }

  return () => {
    for (const type of types) {
      target.removeEventListener(type, listener);
    }

    for (const type of clipboardTypes) {
      target.removeEventListener(type, clipboard);
    }
  };
}
