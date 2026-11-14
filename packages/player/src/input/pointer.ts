// Browser pointer input enters here; Flash chooses targets from its display
// list, while the canvas only supplies the pointer's position and buttons.
import { toStage } from "../display/bounds.js";
import {
  ButtonObject,
  CONTENT,
  type Container,
  type DisplayObject,
  pickWork,
  TextObject,
} from "../display/display.js";
import { apply, invert, type Rect } from "../display/geometry.js";
import { dispatchEvent, heard } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import { maxScrollV } from "../text/layout.js";
import { type Drag, dragTo, dropTargets, objectUnder } from "./drag.js";
import { pointerTarget } from "./hit-test.js";
import type { KeyboardInput } from "./keyboard.js";

export interface PointerState {
  x: number;
  y: number;
  button?: number;
  buttons?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  /** When, in milliseconds, which tells a double click from two clicks. */
  time?: number;
  /** A release the browser took back, as a touch it turned into a scroll: no click. */
  canceled?: boolean;
}

/**
 * The pointer as a host drives it (RenderView.bindPointer, bindKeyboard): an
 * AS3 movie's PointerInput, or an AVM1 movie's (avm1/pointer.ts), whose
 * buttons and clips take the pointer by AVM1's rules.
 */
export interface Pointer {
  /** How many of its events may show before the next frame: a button's state changed, say. */
  readonly redraws: number;
  /** Whether a press here holds the mouse, wherever it goes, until the release. */
  readonly captured: boolean;
  /** Told the cursor to show whenever it changes. */
  onCursor: ((cursor: Cursor) => void) | null;
  cursor(): Cursor;
  /** A move to handle at the next flush; several a frame come to one. */
  post(p: PointerState): void;
  flush(): void;
  handle(type: "move" | "down" | "up" | "leave", p: PointerState): void;
  /** The wheel turned by `delta` lines over `p`; whether the SWF takes it there. */
  wheel(p: PointerState, delta: number): boolean;
  /**
   * Whether the SWF heard the last press of `button`, 1 the middle or 2 the
   * right: the host then keeps the browser's own from it, the context menu
   * Flash and the browser would show for the right, a scroll for the middle.
   */
  taken(button: number): boolean;
}

/** Mouse events on the player's display list, independent of a renderer. */
export class PointerInput implements Pointer {
  /** How many pointer events it has handled. */
  handled = 0;
  /**
   * How many of them may show before the next frame: a button's state,
   * focus or a selection changed. What a mouse listener changes otherwise
   * shows at the next frame, as in Flash, unless it asks updateAfterEvent.
   */
  redraws = 0;
  private hover: DisplayObject | null = null;
  /** The hover and its ancestors as they were when it came over them, nearest first: those its roll outs go to. */
  private hoverChain: DisplayObject[] = [];
  /** The pointer's last state over the player; null before it came, or once it left. */
  private last: PointerState | null = null;
  /** pickWork's count when the hover was last picked. */
  private picked = -1;
  /** Whether the left button is down after a press here. */
  private held = false;
  /** Whether the pointer has left the player, and not come back to it since. */
  private gone = false;
  private pressed: DisplayObject | null = null;
  /** What the middle and the right button were last pressed on, by button, until let go. */
  private pressedOther: (DisplayObject | null)[] = [null, null, null];
  /** Whether the middle and the right button's last press were heard, by button (see taken). */
  private heardOther = [false, false, false];
  /** The last press, which the next continues as a double or triple click if on its target, near it in place and time. */
  private lastPress: {
    x: number;
    y: number;
    time: number;
    clicks: number;
    target: DisplayObject | null;
  } | null = null;
  private moved: PointerState | null = null;
  private shown: Cursor = "default";
  private drag: Drag | null = null;
  /** Told the cursor to show whenever it changes. */
  onCursor: ((cursor: Cursor) => void) | null = null;

  constructor(
    private readonly stage: Container,
    private readonly scripting: Scripting,
    /** What a press tells the keyboard: which field it focuses, and where its caret goes. */
    private readonly keyboard: KeyboardInput | null = null,
  ) {}

  private pick(p: PointerState): DisplayObject | null {
    const s = this.scripting;
    return pointerTarget(
      this.stage,
      p.x,
      p.y,
      s.stageViewportWidth || s.stageWidth,
      s.stageViewportHeight || s.stageHeight,
      s.avm1Input?.hit,
      s.stageViewportX,
      s.stageViewportY,
    );
  }

  /** Flash has one active drag for the whole stage, independent of mouse button state. */
  startDrag(target: DisplayObject, lockCenter: boolean, bounds: Rect | null): void {
    this.drag = {
      target,
      lockCenter,
      bounds,
      lastX: this.scripting.mouseStageX,
      lastY: this.scripting.mouseStageY,
    };
    this.updateDrag();
  }

  /** Ends the mouse's drag; a touch point's stays, as only stopTouchDrag ends it. */
  stopDrag(): void {
    if (this.drag?.touchPointID !== undefined) {
      return;
    }

    this.updateDrag();
    this.drag = null;
  }

  /**
   * A drag that touch point `id` moves, from where it is (`at`, null while it
   * is not down: the target stays until it moves). The one drag there is,
   * the mouse's or another point's, gives way to it.
   */
  startTouchDrag(
    target: DisplayObject,
    id: number,
    lockCenter: boolean,
    bounds: Rect | null,
    at: { x: number; y: number } | null,
  ): void {
    this.drag = {
      target,
      lockCenter,
      bounds,
      lastX: at?.x ?? Number.NaN,
      lastY: at?.y ?? Number.NaN,
      touchPointID: id,
    };
    if (at) {
      this.updateDrag(id, at.x, at.y);
    }
  }

  /** Ends touch point `id`'s drag, where it is (`at`), and no other. */
  stopTouchDrag(id: number, at: { x: number; y: number } | null): void {
    const drag = this.drag;
    if (drag?.touchPointID !== id) {
      return;
    }

    if (at) {
      this.dragTouch(id, at.x, at.y);
    }

    this.drag = null;
  }

  /** Touch point `id` at (x, y) on the stage: what it drags follows it (TouchInput). */
  dragTouch(id: number, x: number, y: number): void {
    const drag = this.drag;
    if (drag?.touchPointID !== id) {
      return;
    }

    // Begun while the point was up: it moves the target from where the point comes down.
    if (Number.isNaN(drag.lastX)) {
      drag.lastX = x;
      drag.lastY = y;
    }

    this.updateDrag(id, x, y);
  }

  /** Moves the drag that `touchPointID` moves, or the mouse's, to (x, y). */
  private updateDrag(
    touchPointID?: number,
    x = this.scripting.mouseStageX,
    y = this.scripting.mouseStageY,
  ): void {
    const drag = this.drag;
    if (!drag || drag.touchPointID !== touchPointID) {
      return;
    }

    const d = drag.target;
    if (dragTo(this.stage, drag, x, y)) {
      this.redraws++;
    }

    let under = objectUnder(this.stage, x, y, d);
    while (under && !under.object) {
      under = under.parent;
    }

    dropTargets.set(d, under === this.stage ? null : under);
  }

  private send(
    type: string,
    target: DisplayObject,
    p: PointerState,
    buttonDown: boolean,
    bubbles = true,
    related: DisplayObject | null = null,
    delta = 0,
  ): void {
    if (!target.object) {
      return;
    }

    const m = invert(toStage(target, this.stage));
    const [x, y] = m ? apply(m, p.x, p.y) : [Number.NaN, Number.NaN];
    const s = this.scripting;
    const event = s.rt.construct(
      s.rt.classNamed("flash.events::MouseEvent"),
      type,
      bubbles,
      false,
      x,
      y,
      related?.object ?? null,
      !!p.ctrlKey,
      !!p.altKey,
      !!p.shiftKey,
      buttonDown,
      delta,
    );
    dispatchEvent(s, target.object, event);
  }

  /**
   * A move to handle at the next flush: at the start of the player's next
   * frame, or before the next other input, whichever comes first. A host
   * gets several a frame, of which only the last one shows.
   */
  post(p: PointerState): void {
    this.moved = p;
  }

  /** Handle the move posted, if any. */
  flush(): void {
    const p = this.moved;
    if (p) {
      this.handle("move", p);
    }
  }

  /**
   * Flash Player 32's order, measured: a pointer at a new point first sends
   * `mouseMove` to what is under it, then moves the hover there (`mouseOut`
   * and roll outs from what it was over, roll overs and `mouseOver` on what
   * it is over), and only then a press or a release; a press or a release
   * where the pointer already was sends its own events first, then any
   * hover that changed. A move to where the pointer already is sends
   * nothing.
   */
  handle(type: "move" | "down" | "up" | "leave", p: PointerState): void {
    // A move posted before this input comes first; a move given now replaces it.
    if (type === "move") {
      this.moved = null;
    } else {
      this.flush();
    }

    if (type === "leave") {
      // While its button is down, Flash keeps the mouse when it leaves: the
      // moves outside go on, to the stage, until the release.
      if (!this.held) {
        this.handled++;
        this.redraws++;
        this.redraws += this.scripting.avm1Input?.leave(p) ?? 0;
        this.leave(p);
        this.updateCursor();
      }

      return;
    }

    const s = this.scripting;
    // A release the host never sent, as one outside the browser, or the left
    // button's let go while another stays down, which Chrome tells as a move:
    // the release it was, there, and the leave after it where that is outside.
    if (type === "move" && this.held && p.buttons !== undefined && !(p.buttons & 1)) {
      this.handle("up", { ...p, button: 0 });
      if (!this.pick(p)) {
        this.handle("leave", p);
      }

      return;
    }

    const moved = p.x !== s.mouseStageX || p.y !== s.mouseStageY;
    if (type === "move" && !moved) {
      return;
    }

    this.handled++;
    s.mouseStageX = p.x;
    s.mouseStageY = p.y;
    this.last = p;
    this.updateDrag();
    s.avm1Input?.broadcast(type, p);
    this.picked = pickWork.changes;
    const found = this.pick(p);
    this.redraws += s.avm1Input?.prepare(type, p, found) ?? 0;
    // AVM1 buttons send no AS3 events. Outside, a held mouse stays the stage's.
    const target = found?.avm1Root
      ? null
      : (found ?? (this.held && this.stage.object ? this.stage : null));
    if (found) {
      this.gone = false;
    }

    // The empty stage takes the mouse's events, but no one is over it.
    const over = target === this.stage ? null : target;
    const down = (p.buttons ?? 0) & 1 ? true : type === "down" && (p.button ?? 0) === 0;

    // What may show at once, rather than at the next frame: a hover that
    // moves on or off a button or a sprite in buttonMode, as Ruffle redraws
    // for, and more than Ruffle, any press or release, which may move focus
    // and a caret, and a drag selecting text.
    if (type !== "move" || (over !== this.hover && (buttonLike(over) || buttonLike(this.hover)))) {
      this.redraws++;
    }

    // The move a press or a release at a new point makes is the button's state before it.
    const moveDown = type === "move" ? down : this.held;
    if (moved) {
      if (target) {
        this.send("mouseMove", target, p, moveDown);
      }

      this.hoverTo(over, p, moveDown);
      // A drag from a field selects in it, wherever the pointer goes.
      const pressed = this.pressed;
      if (moveDown && pressed instanceof TextObject && this.keyboard) {
        const m = invert(toStage(pressed, this.stage));
        if (m) {
          this.keyboard.dragged(pressed, ...apply(m, p.x, p.y));
          this.redraws++;
        }
      }
    }

    if (type !== "move" && (p.button ?? 0) === 0) {
      // A press or a release is a user's gesture, in whose handlers alone a
      // script may write to the clipboard: not the hover's events around it.
      this.scripting.clipboard.gesture(() => this.button(type, target, p));
    }

    if (type !== "move" && (p.button === 1 || p.button === 2)) {
      // Over nothing, the stage, as Ruffle sends them.
      this.otherButton(type, p.button, found?.avm1Root ? null : (target ?? this.stage), p);
    }

    if (type !== "move") {
      this.redraws += s.avm1Input?.finish(type, p) ?? 0;
    }

    if (!moved) {
      this.hoverTo(over, p, down);
    }

    this.updateCursor();
  }

  /**
   * The wheel turned by `delta` lines over the player, up positive, as
   * MouseEvent.delta has it: a move to `p` first, if the pointer was not
   * there, then `mouseWheel` to what is under it, bubbling, and a text
   * field under it whose mouseWheelEnabled is true scrolls by as many
   * lines, after the event, as the corpus's `mouse_wheel_events` has
   * Flash do. A delta of 0, part of a line a touchpad gave, sends nothing.
   * Returns whether the SWF takes the wheel there, a listener for
   * mouseWheel on the way or a field that can scroll, which a host lets
   * the page scroll without.
   */
  wheel(p: PointerState, delta: number): boolean {
    this.handle("move", p);
    const s = this.scripting;
    const found = pointerTarget(
      this.stage,
      p.x,
      p.y,
      s.stageViewportWidth || s.stageWidth,
      s.stageViewportHeight || s.stageHeight,
      undefined,
      s.stageViewportX,
      s.stageViewportY,
    );
    const target = found ?? (this.held && this.stage.object ? this.stage : null);
    if (!target?.object) {
      return false;
    }

    const field = target instanceof TextObject && target.mouseWheelEnabled ? target : null;
    const taken = heard(target.object, "mouseWheel") || (!!field && maxScrollV(field) > 1);
    if (delta !== 0) {
      this.handled++;
      this.send("mouseWheel", target, p, this.held, true, null, delta);
      if (field) {
        const scrollV = Math.max(1, Math.min(field.scrollV - delta, maxScrollV(field)));
        if (scrollV !== field.scrollV) {
          field.scrollV = scrollV;
          field.invalidate(CONTENT);
          this.redraws++;
        }
      }
    }

    return taken;
  }

  /** Whether the left button is down after a press the player took, which keeps the mouse its own wherever it goes. */
  get captured(): boolean {
    return this.held;
  }

  /**
   * At a frame's end, after its EXIT_FRAME and before its RENDER, as Flash
   * Player 32 does: what is under a pointer that has not moved, picked
   * again if the display list or a pick's field changed since the last
   * pick, and the hover moved to it with no mouseMove. An object that
   * moves out from under the mouse or is hidden so gets its outs, one
   * that comes under it its overs, and the cursor follows. Flash notices
   * one moved in under the mouse a frame later than one moved out, which
   * the player does not copy.
   */
  frameEnded(): void {
    const p = this.last;
    if (p && !this.gone && this.picked !== pickWork.changes) {
      const s = this.scripting;
      this.picked = pickWork.changes;
      const found = this.pick(p);
      this.redraws += s.avm1Input?.sync(p, found) ?? 0;
      const target = found?.avm1Root
        ? null
        : (found ?? (this.held && this.stage.object ? this.stage : null));
      const over = target === this.stage ? null : target;
      if (over !== this.hover) {
        this.handled++;
        if (buttonLike(over) || buttonLike(this.hover)) {
          this.redraws++;
        }

        this.hoverTo(over, p, this.held);
      }
    }

    this.updateCursor();
  }

  /** Move the hover to `target`: out and roll outs from what it was over, roll overs and over on what it is. */
  private hoverTo(target: DisplayObject | null, p: PointerState, down: boolean): void {
    const previous = this.hover;
    if (target === previous) {
      return;
    }

    const entered = new Set<DisplayObject>();
    for (let d = target; d; d = d.parent) {
      entered.add(d);
    }

    // Left as they were when the hover came: one a script took off the
    // list rolls out of the ancestors it had, as in Flash.
    const left = this.hoverChain;
    let common: DisplayObject | null = this.stage;
    let leaving = left.length;
    if (target) {
      for (let i = 0; i < left.length; i++) {
        if (entered.has(left[i])) {
          common = left[i];
          leaving = i;
          break;
        }
      }
    }

    // A pressed button the pointer drags off shows over until the release,
    // and down again when it comes back; one it is dragged onto stays up,
    // as Flash Player 32 shows them.
    const held = down && this.pressed;
    if (previous) {
      buttonState(previous, previous === held ? "over" : "up", previous !== held);
      // Off the stage, it hears no mouseOut, only its roll outs.
      if (this.stage.encloses(previous)) {
        this.send("mouseOut", previous, p, down, true, target);
      }

      for (let i = 0; i < leaving; i++) {
        if (left[i] !== this.stage) {
          this.send("rollOut", left[i], p, down, false, target);
        }
      }
    }

    if (target) {
      if (!held) {
        buttonState(target, "over");
      } else if (target === held) {
        buttonState(target, "down", false);
      }

      for (let d: DisplayObject | null = target; d && d !== common; d = d.parent) {
        this.send("rollOver", d, p, down, false, previous);
      }

      this.send("mouseOver", target, p, down, true, previous);
    }

    this.hover = target;
    const chain: DisplayObject[] = [];
    for (let d = target; d; d = d.parent) {
      chain.push(d);
    }

    this.hoverChain = chain;
  }

  /**
   * The pointer gone from the player: out of what it was over, then the
   * stage's `mouseLeave`. Flash leaves the mouse's position where it was
   * but gives the out and roll outs the stage point (-1, -1).
   */
  private leave(p: PointerState): void {
    // Once, until the pointer is back: a host may tell of a leave twice.
    if (this.gone) {
      return;
    }

    this.gone = true;
    this.last = null;
    this.hoverTo(null, { ...p, x: -1, y: -1 }, false);
    const stage = this.stage.object;
    if (stage && heard(stage, "mouseLeave")) {
      dispatchEvent(this.scripting, stage, this.scripting.event("mouseLeave"));
    }
  }

  /** The left button pressed or let go over `target`: focus, a button's state, and the mouse events. */
  private button(type: "down" | "up", target: DisplayObject | null, p: PointerState): void {
    if (type === "down") {
      this.held = true;
      this.pressed = target;
      // Ruffle's rule: within half a second and two pixels of the last
      // press; and on its target, as Flash Player 32 counts a double click.
      const last = this.lastPress;
      const time = p.time ?? Number.NaN;
      const again =
        last !== null &&
        last.target === target &&
        Math.abs(time - last.time) < 500 &&
        (p.x - last.x) ** 2 + (p.y - last.y) ** 2 < 4;
      const clicks = again ? last.clicks + 1 : 1;
      this.lastPress = { x: p.x, y: p.y, time, clicks, target };
      if (this.keyboard) {
        const m = target && invert(toStage(target, this.stage));
        const [x, y] = m ? apply(m, p.x, p.y) : [0, 0];
        this.keyboard.pressed(target, x, y, clicks);
      }

      if (target) {
        buttonState(target, "down");
        this.send("mouseDown", target, p, true);
      }
    } else {
      const pressed = this.pressed;
      if (pressed instanceof ButtonObject && pressed !== target && pressed.enabled) {
        pressed.releasedOutside();
      }

      if (target) {
        buttonState(target, "over");
        this.send("mouseUp", target, p, false);
      }

      // The second click of a double, on an object whose doubleClickEnabled
      // is true, is a doubleClick in its place, as Flash Player 32 sends it;
      // a third is a click again.
      if (target && target === this.pressed && !p.canceled) {
        const double =
          this.lastPress?.clicks === 2 &&
          (target.object as { $doubleClickEnabled?: boolean } | null)?.$doubleClickEnabled;
        this.send(double ? "doubleClick" : "click", target, p, false);
      }

      this.pressed = null;
      this.held = false;
    }
  }

  /**
   * The middle (1) or right (2) button pressed or let go over `target`, as
   * Flash Player 11.2 added them: middleMouseDown or rightMouseDown, then
   * the Up, and the Click where it was pressed, as Ruffle's corpus has
   * Flash send them. A right press a rightMouseDown or rightClick listener
   * hears is the SWF's, and shows no context menu, as Ruffle takes it.
   */
  private otherButton(
    type: "down" | "up",
    button: 1 | 2,
    target: DisplayObject | null,
    p: PointerState,
  ): void {
    const name = button === 2 ? "right" : "middle";
    if (type === "down") {
      this.pressedOther[button] = target;
      const object = target?.object;
      this.heardOther[button] =
        !!object && (heard(object, `${name}MouseDown`) || heard(object, `${name}Click`));
      if (target) {
        this.send(`${name}MouseDown`, target, p, true);
      }

      return;
    }

    if (target) {
      this.send(`${name}MouseUp`, target, p, false);
      if (target === this.pressedOther[button]) {
        this.send(`${name}Click`, target, p, false);
      }
    }

    this.pressedOther[button] = null;
  }

  taken(button: number): boolean {
    return this.heardOther[button] ?? false;
  }

  /** Show a changed cursor immediately, including when a script hides or shows it. */
  updateCursor(): void {
    const cursor = this.cursor();
    if (cursor !== this.shown) {
      this.shown = cursor;
      this.onCursor?.(cursor);
    }
  }

  /**
   * The cursor to show: none while Mouse.hide holds, the one Mouse.cursor
   * names unless it is "auto", a registered one before Flash's own of the
   * same name, and otherwise the one over what the pointer is on, as Ruffle
   * chooses it: a hand over a button that uses one, or under the nearest
   * sprite in buttonMode whose useHandCursor and enabled are true; an
   * I-beam over selectable text, whose links do not show a hand yet.
   */
  cursor(): Cursor {
    const s = this.scripting;
    if (s.mouseVisible === false) {
      return "none";
    }

    const named = s.mouseCursor;
    if (named !== "auto") {
      const forced = s.cursors?.get(named) ?? FORCED.get(named);
      if (forced) {
        return forced;
      }
    }

    const legacy = s.avm1Input?.cursor();
    if (legacy) {
      return legacy;
    }

    const d = this.hover;
    // A disabled button keeps its hand, as Ruffle's AVM2 button does.
    if (d instanceof ButtonObject) {
      return d.useHandCursor ? "pointer" : "default";
    }

    if (d instanceof TextObject) {
      return d.selectable ? "text" : "default";
    }

    for (let o = d; o; o = o.parent) {
      const fields = o.object as Partial<
        Record<"$buttonMode" | "$useHandCursor" | "$enabled", boolean>
      >;
      if (fields?.$buttonMode) {
        return fields.$useHandCursor !== false && fields.$enabled !== false ? "pointer" : "default";
      }
    }

    return "default";
  }
}

/** A CSS cursor the host shows over the player; a registered one is its image's `url(...)`. */
export type Cursor = "default" | "pointer" | "text" | "grab" | "none" | `url(${string}`;

/** flash.ui.MouseCursor's names as CSS: "hand" is Flash's dragging hand, as Ruffle shows it. */
const FORCED: ReadonlyMap<string, Cursor> = new Map<string, Cursor>([
  ["arrow", "default"],
  ["button", "pointer"],
  ["hand", "grab"],
  ["ibeam", "text"],
]);

/** Whether `d` is a button, or a sprite in buttonMode, whose hover Ruffle redraws for. */
function buttonLike(d: DisplayObject | null): boolean {
  return (
    d instanceof ButtonObject || !!(d?.object as { $buttonMode?: boolean } | null)?.$buttonMode
  );
}

/**
 * Show state `state` of `d`, if it is an enabled button, with the sound for
 * the change unless `sound` is false: the pointer moves a disabled one
 * through none.
 */
function buttonState(d: DisplayObject, state: "up" | "over" | "down", sound = true): void {
  if (d instanceof ButtonObject && d.enabled) {
    d.setState(state, sound);
  }
}
