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
import { dispatchEvent, heard } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import { caretAt, pasteable, selectionAt, TextEditor } from "./text-editor.js";
import { isTextInput } from "./text-input.js";

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
 * when it is taken off the list or hidden. `highlight`, as Tab and a
 * script move it, shows its rectangle; a press's move does not.
 */
export function setFocus(s: Scripting, next: DisplayObject | null, highlight = false): void {
  const previous = s.focus;
  s.focusHighlight = highlight && next !== null && highlightable(s, next);
  if (previous === next) {
    return;
  }

  // One focus in the player: the AVM1 movies the host's Loaders hold give theirs up first. One
  // whose onKillFocus takes it back keeps it, its setFocus(null) having told `previous`. A move
  // among AS3's objects, or to or from none, the movies' Selection listeners hear as one from
  // null to null (Flash Player 32), before the focusOut.
  if (s.avm1Input) {
    if (next && s.avm1Input.focused()) {
      s.avm1Input.blur();
      if (s.focus !== previous || s.avm1Input?.focused()) {
        return;
      }
    } else {
      // The focus is `next`'s as they hear it, as in Flash Player 32: a listener's
      // Selection.setFocus takes it from `next`, which then hears a focusOut and no focusIn.
      s.focus = next;
      s.avm1Input.hostMoved();
      if (s.focus !== next) {
        return;
      }

      s.focus = previous;
    }
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

  // A field given the focus scrolls to its caret, as adl's does.
  if (next instanceof TextObject && next !== previous) {
    next.scrollTo(next.caret);
  }

  if (previous) {
    focusEvent(s, "focusOut", previous, next, false);
  }

  if (next && s.focus === next) {
    focusEvent(s, "focusIn", next, previous, false);
  }
}

/** What the focus's rectangle is drawn around: what has the focus, where it shows (setFocus). */
export const highlighted = (s: Scripting): DisplayObject | null =>
  s.focusHighlight ? s.focus : null;

/**
 * Whether the focus's rectangle shows on `d` as the focus moves to it: not
 * on a text field, which shows its caret instead, nor on the stage or the
 * root, which a script focuses to hear the keys, nor where its focusRect
 * is false, or null and the stage's stageFocusRect is. A change of either
 * later leaves it as it is, as in Flash Player 32's projector.
 */
function highlightable(s: Scripting, d: DisplayObject): boolean {
  if (d instanceof TextObject || d === s.stage || d === s.root) {
    return false;
  }

  const own = (d.object as { $focusRect?: unknown } | null)?.$focusRect;
  return own === null || own === undefined ? s.stageFocusRect : s.rt.toBoolean(own);
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
  /** Whether what has focus takes text: an input field, into which `insert` types. */
  readonly editing: boolean;
  /**
   * Text an input method committed, an IME's or a soft keyboard's, with no
   * key of its own: the input field with focus takes it as typed, with one
   * TextEvent for all of it. Whether a field took it.
   */
  insert(text: string): boolean;
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
    {
      heard: (field) => !!field.object && heard(field.object, "scroll"),
      tell: (field) => {
        if (field.object) {
          dispatchEvent(this.scripting, field.object, this.scripting.event("scroll"));
        }
      },
    },
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
    const fullScreen = this.scripting.fullScreen;
    const asked = fullScreen.asked;
    // A key is a user's gesture, in whose handlers a script may write to the clipboard.
    const used = this.scripting.clipboard.gesture(() => this.key(type, k, edits));

    // A key whose listeners took the stage into or out of full screen is the SWF's key for
    // it, as F11 is an AIR application's: the host's own for the same key, a menu's F11,
    // would undo it at once.
    return used || fullScreen.asked !== asked;
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
      const loaded = this.loaded();
      if (loaded) {
        return loaded.text(k);
      }

      const focus = this.focused();
      if (k.ctrlKey && !k.altKey && k.keyCode === 65) {
        return this.selectAll(focus);
      }

      return focus instanceof TextObject && (focus.type === "input" || focus.selectable)
        ? this.editor.edit(focus, k)
        : false;
    });
  }

  get editing(): boolean {
    const focus = this.focused();
    return (
      (focus instanceof TextObject && focus.type === "input") || (this.loaded()?.editing ?? false)
    );
  }

  insert(text: string): boolean {
    this.handled++;
    return this.scripting.clipboard.gesture(() => {
      const loaded = this.loaded();
      if (loaded) {
        return loaded.insert(text);
      }

      const focus = this.focused();
      if (!(focus instanceof TextObject) || focus.type !== "input") {
        return false;
      }

      const typed = pasteable(focus.multiline, text);
      return typed !== "" && this.editor.type(focus, typed);
    });
  }

  private key(type: "down" | "up", k: KeyState, edits: boolean): boolean {
    const s = this.scripting;
    // No KeyboardEvent while a loaded AVM1 movie has the focus, as Flash Player 32 sends none.
    const target = this.loaded() ? null : (this.focused() ?? this.stage);
    if (target?.object) {
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

    // The AVM1 movies the host's Loaders hold hear every key, after its listeners, as Flash
    // Player 32 sends it; one that has the focus types or presses with it, Tab aside.
    const used = s.avm1Input?.key(type, k, edits) ?? false;
    if (type !== "down") {
      return false;
    }

    if (k.keyCode === TAB) {
      return used || this.tab(!!k.shiftKey);
    }

    if (this.loaded()) {
      return used;
    }

    if (!edits) {
      return false;
    }

    // What has focus once the key's listeners ran, as Flash types into it: a keyDown listener
    // that focuses a field, as a chat opened by its key, has the key's character typed there.
    const focus = this.focused();

    // Ctrl with Alt is AltGr on some layouts, which types characters.
    if (k.ctrlKey && !k.altKey && (k.keyCode === 65 || k.charCode === 97 || k.charCode === 65)) {
      return this.selectAll(focus);
    }

    if (focus instanceof TextObject && (focus.type === "input" || focus.selectable)) {
      return this.editor.edit(focus, k);
    }

    return false;
  }

  /** The keyboard of a loaded AVM1 movie that has the focus, where one has it. */
  private loaded(): Keyboard | null {
    return this.scripting.avm1Input?.focused() ?? null;
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
    const loaded = this.loaded();
    if (loaded) {
      return loaded.copy(cut);
    }

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
    const loaded = this.loaded();
    if (loaded) {
      return loaded.paste(data);
    }

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
   * field's caret where it was clicked. A press on a button of a loaded
   * AVM1 movie, `onMovie`, moves no focus, though what has it hears the
   * mouseFocusChange, naming nothing, as Flash Player 32 has it; while a
   * movie's field has the focus, there is no mouseFocusChange at all.
   */
  pressed(
    target: DisplayObject | null,
    localX: number,
    localY: number,
    clicks = 1,
    onMovie = false,
  ): void {
    const s = this.scripting;
    s.focusHighlight = false;
    this.press = null;
    if (onMovie) {
      if (s.focus && focusableByMouse(s.focus)) {
        focusEvent(s, "mouseFocusChange", s.focus, null, true);
      }

      return;
    }

    const pressed = target === this.stage ? null : target;
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

    // While a loaded AVM1 movie's field has the focus, AS3 hears no mouseFocusChange: the field
    // loses it as AS3's object takes it, or as the press elsewhere drops it (Flash Player 32).
    const fromMovie = s.avm1Input?.focused() ?? null;
    if (
      fromMovie === null &&
      focusEvent(s, "mouseFocusChange", s.focus ?? this.stage, pressed, true)
    ) {
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
   * one of each place, as Flash orders them. The objects of the AVM1 movies
   * the host's Loaders hold are in the same order, each as its movie has
   * it (avm1/focus.ts), as Flash Player 32 tabs between them; a move from
   * one of them, or from nothing to one, sends no keyFocusChange, and a
   * move to one names nothing.
   * A field it focuses has all its text selected.
   */
  private tab(back: boolean): boolean {
    const s = this.scripting;
    const loaded = s.avm1Input;
    // Each object, its tabIndex, if any, and the root of the loaded AVM1 movie it is in, if any.
    const found: { d: DisplayObject; index: number | undefined; movie: DisplayObject | null }[] =
      [];
    const walk = (d: DisplayObject) => {
      for (const child of (d as Container).children ?? []) {
        if (!child.visible) {
          continue;
        }

        const movie = loaded?.tabbables(child) ?? null;
        if (movie) {
          for (const t of movie) {
            found.push({ d: t.d, index: t.index, movie: child });
          }

          continue;
        }

        if (tabbable(child, this.stage)) {
          const index = fieldsOf(child).$tabIndex ?? -1;
          found.push({ d: child, index: index >= 0 ? index : undefined, movie: null });
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

    const indexed = found.filter((t) => t.index !== undefined);
    let order: typeof found;
    if (indexed.length > 0) {
      order = indexed
        .map((t, i) => ({ t, i, key: t.index ?? 0 }))
        .sort((a, b) => a.key - b.key || a.i - b.i)
        .map((e) => e.t);
    } else {
      const keyed = found.map((t, i) => ({ t, i, key: placeKey(t.d, this.stage) }));
      keyed.sort((a, b) => a.key - b.key || a.i - b.i);
      order = keyed.filter((e, j) => j === 0 || e.key !== keyed[j - 1].key).map((e) => e.t);
    }

    if (order.length === 0) {
      return false;
    }

    const inMovie = loaded?.focused()?.focused ?? null;
    const current = s.focus ?? inMovie;
    const at = current ? order.findIndex((t) => t.d === current) : -1;
    const n = order.length;
    const next = order[at < 0 ? (back ? n - 1 : 0) : (at + (back ? -1 : 1) + n) % n];
    // From nothing to a movie's object, Flash Player 32 sends no keyFocusChange either.
    if (
      inMovie === null &&
      (s.focus !== null || next.movie === null) &&
      focusEvent(s, "keyFocusChange", s.focus ?? this.stage, next.movie ? null : next.d, true, TAB)
    ) {
      return true;
    }

    if (next.movie) {
      loaded?.tabTo(next.movie, next.d);
      return true;
    }

    setFocus(s, next.d, true);
    // A field Tab focuses has all its text selected, so what is typed replaces it (Flash Player 32).
    if (next.d instanceof TextObject && s.focus === next.d) {
      next.d.select(0, next.d.model.text.length);
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
  if (isTextInput(into)) {
    return false;
  }

  return (
    !!into?.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(into?.tagName ?? "")
  );
}

/**
 * Send the browser's keys on `target` (the window, say) to the player. A
 * key goes to the SWF unless it is typed into the page's own input or
 * button, or composes an IME's text, which comes by bindTextInput; the
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
