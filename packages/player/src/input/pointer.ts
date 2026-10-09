// Browser pointer input enters here; Flash chooses targets from its display
// list, while Pixi only supplies the pointer's position and buttons.
import { hitsOwnPoint, hitsPoint, toStage } from "../display/bounds.js";
import {
  BitmapObject,
  ButtonObject,
  Container,
  type DisplayObject,
  ShapeObject,
  StaticTextObject,
  TextObject,
} from "../display/display.js";
import { apply, invert, type Rect } from "../display/geometry.js";
import { dispatchEvent, heard } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
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
 * What a pick finds: an interactive object hit, a hit that goes up to the
 * first ancestor with mouseEnabled, or nothing.
 */
const PROPAGATE = "propagate";
type Pick = DisplayObject | typeof PROPAGATE | null;

/**
 * An InteractiveObject's kind: what picks for itself, rather than through
 * its parent. An AVM1 movie's root is an AVM1Movie, no InteractiveObject:
 * a hit on it goes to its Loader, as Flash has it (the corpus's
 * `mouse_pick_loader_avm1`).
 */
const isInteractive = (d: DisplayObject): boolean =>
  !(
    d instanceof ShapeObject ||
    d instanceof BitmapObject ||
    d instanceof StaticTextObject ||
    d.avm1Root
  );

const mouseEnabled = (d: DisplayObject): boolean =>
  !!d.object && !d.avm1Root && d.object.$mouseEnabled !== false;

/** `d` itself where it takes the pointer, else the hit goes on to its parent. */
const own = (d: DisplayObject): Pick => (mouseEnabled(d) ? d : PROPAGATE);

/** Each sprite's hitArea. */
const hitAreas = new WeakMap<DisplayObject, DisplayObject>();

/** Sprite.hitArea: `area` picks for `sprite` in place of its own drawing. */
export function setHitArea(sprite: DisplayObject, area: DisplayObject | null): void {
  if (area) {
    hitAreas.set(sprite, area);
  } else {
    hitAreas.delete(sprite);
  }
}

export function hitAreaOf(sprite: DisplayObject): DisplayObject | null {
  return hitAreas.get(sprite) ?? null;
}

/**
 * The object under a point, in stage coordinates, as Flash picks it
 * (Ruffle's `mouse_pick_avm2`): within a container, its interactive
 * children first, topmost first, then the rest. A hit on artwork, or on
 * a child whose mouseEnabled is false, goes to the nearest ancestor that
 * takes the pointer; one that goes up is kept while the search goes on,
 * so a disabled field over a button leaves the button its clicks.
 *
 * A sprite with a hitArea is hit where the area draws, wherever the area
 * is on the display list and whether or not it is visible, and its own
 * drawing counts for nothing; its interactive children still pick, unless
 * its mouseChildren is false. An area off the display list hits nothing.
 * The area itself is left as it was, mouseEnabled and all, as adl leaves
 * it: shown and enabled, it takes the pointer itself where it is on top,
 * as Flash's documentation warns. Ruffle reads AVM2's hitArea for nothing.
 */
export function pointerTarget(
  stage: Container,
  x: number,
  y: number,
  width: number,
  height: number,
): DisplayObject | null {
  // Whether `d`'s artwork is under the point, its children's included.
  const drawn = (d: DisplayObject): boolean => {
    if (!d.visible || d.clipDepth > 0 || d.maskOf) {
      return false;
    }

    if (d instanceof Container && d.children.some(drawn)) {
      return true;
    }

    return hitsOwnPoint(d, x, y, stage, true);
  };

  const pick = (d: DisplayObject): Pick => {
    if (!d.visible || d.clipDepth > 0 || d.maskOf) {
      return null;
    }

    // A button is hit where its hit test state is, whatever state it shows,
    // and is the target itself, its states' objects never. The hit test
    // state is in no container: it is tested as the button's child.
    if (d instanceof ButtonObject) {
      const area = d.hitTestState;
      if (!area) {
        return null;
      }

      const parent = area.parent;
      area.parent = d;
      // A disabled button is missed, not passed up: what is under it gets the hit (Ruffle).
      try {
        return mouseEnabled(d) && drawn(area) ? d : null;
      } finally {
        area.parent = parent;
      }
    }

    if (!(d instanceof Container)) {
      return hitsOwnPoint(d, x, y, stage, true) ? own(d) : null;
    }

    const area = hitAreas.get(d);
    const areaHit = area && area !== d ? () => hitsPoint(area, x, y, true, stage) : null;
    if (areaHit && d.object?.$mouseChildren === false) {
      return areaHit() ? own(d) : null;
    }

    // Two passes rather than a sorted copy: this runs on every pointer move.
    const children = d.children;
    let propagated = false;

    for (let i = children.length - 1; i >= 0; i--) {
      if (!isInteractive(children[i])) {
        continue;
      }

      const found = pick(children[i]);
      if (found === PROPAGATE) {
        propagated = true;
      } else if (found) {
        // A container whose mouseChildren is false takes its children's hits itself.
        return d.object?.$mouseChildren === false ? own(d) : found;
      }
    }

    if (areaHit) {
      return areaHit() ? own(d) : null;
    }

    if (propagated) {
      return own(d);
    }

    for (let i = children.length - 1; i >= 0; i--) {
      if (!isInteractive(children[i]) && drawn(children[i])) {
        return own(d);
      }
    }

    return hitsOwnPoint(d, x, y, stage, true) ? own(d) : null;
  };

  if (x < 0 || y < 0 || x >= width || y >= height) {
    return null;
  }

  const found = pick(stage);
  if (found && found !== PROPAGATE) {
    return found;
  }

  return stage.object ? stage : null;
}

/** What each sprite dragged was last over, which Sprite.dropTarget reads. */
const dropTargets = new WeakMap<DisplayObject, DisplayObject | null>();

export function dropTargetOf(d: DisplayObject): DisplayObject | null {
  return dropTargets.get(d) ?? null;
}

/**
 * The topmost object drawing under a point, outside `dragged`, as Flash's
 * dropTarget names it: the shape itself, not the sprite that would take
 * the pointer, whatever its mouseEnabled (Flash's trace of the corpus's
 * `sprite_dropTarget` names the unnamed shapes in its sprites, where
 * Ruffle's names the sprites), and null over nothing, not the stage.
 */
function objectUnder(
  stage: Container,
  x: number,
  y: number,
  dragged: DisplayObject,
): DisplayObject | null {
  const visit = (d: DisplayObject): DisplayObject | null => {
    if (d === dragged || !d.visible || d.clipDepth > 0 || d.maskOf) {
      return null;
    }

    if (d instanceof Container) {
      for (let i = d.children.length - 1; i >= 0; i--) {
        const found = visit(d.children[i]);
        if (found) {
          return found;
        }
      }
    }

    return d !== stage && hitsOwnPoint(d, x, y, stage, true) ? d : null;
  };

  return visit(stage);
}

/** Mouse events on the player's display list, independent of a renderer. */
export class PointerInput {
  /** How many pointer events it has handled. */
  handled = 0;
  /**
   * How many of them may show before the next frame: a button's state,
   * focus or a selection changed. What a mouse listener changes otherwise
   * shows at the next frame, as in Flash, unless it asks updateAfterEvent.
   */
  redraws = 0;
  private hover: DisplayObject | null = null;
  /** Whether the left button is down after a press here. */
  private held = false;
  /** Whether the pointer has left the player, and not come back to it since. */
  private gone = false;
  private pressed: DisplayObject | null = null;
  /** The last press, which the next continues as a double or triple click if near it in place and time. */
  private lastPress: { x: number; y: number; time: number; clicks: number } | null = null;
  private moved: PointerState | null = null;
  private shown: Cursor = "default";
  private drag: {
    target: DisplayObject;
    lockCenter: boolean;
    bounds: Rect | null;
    lastX: number;
    lastY: number;
  } | null = null;
  /** Told the cursor to show whenever it changes. */
  onCursor: ((cursor: Cursor) => void) | null = null;

  constructor(
    private readonly stage: Container,
    private readonly scripting: Scripting,
    /** What a press tells the keyboard: which field it focuses, and where its caret goes. */
    private readonly keyboard: KeyboardInput | null = null,
  ) {}

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

  stopDrag(): void {
    this.updateDrag();
    this.drag = null;
  }

  private updateDrag(): void {
    const drag = this.drag;
    if (!drag) {
      return;
    }

    const d = drag.target;
    const parent = d.parent;
    const inverse = parent ? invert(toStage(parent, this.stage)) : null;
    const x = this.scripting.mouseStageX;
    const y = this.scripting.mouseStageY;
    const [atX, atY] = inverse ? apply(inverse, x, y) : [x, y];
    const [lastX, lastY] = inverse
      ? apply(inverse, drag.lastX, drag.lastY)
      : [drag.lastX, drag.lastY];
    let nextX = drag.lockCenter ? atX : d.matrix.tx + atX - lastX;
    let nextY = drag.lockCenter ? atY : d.matrix.ty + atY - lastY;
    if (drag.bounds) {
      nextX = Math.max(drag.bounds.xMin, Math.min(nextX, drag.bounds.xMax));
      nextY = Math.max(drag.bounds.yMin, Math.min(nextY, drag.bounds.yMax));
    }

    // Flash stores translations in twips, including positions reached by dragging.
    nextX = Math.round(nextX * 20) / 20;
    nextY = Math.round(nextY * 20) / 20;
    if (nextX !== d.matrix.tx || nextY !== d.matrix.ty) {
      d.setMatrix({ ...d.matrix, tx: nextX, ty: nextY });
      d.touch();
      this.redraws++;
    }

    drag.lastX = x;
    drag.lastY = y;
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
      0,
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
      if (!pointerTarget(this.stage, p.x, p.y, s.stageWidth, s.stageHeight)) {
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
    this.updateDrag();
    const found = pointerTarget(this.stage, p.x, p.y, s.stageWidth, s.stageHeight);
    // Outside the stage while the button is down, the mouse is still the stage's.
    const target = found ?? (this.held && this.stage.object ? this.stage : null);
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

    if (!moved) {
      this.hoverTo(over, p, down);
    }

    this.updateCursor();
  }

  /** Whether the left button is down after a press the player took, which keeps the mouse its own wherever it goes. */
  get captured(): boolean {
    return this.held;
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

    let common: DisplayObject | null = this.stage;
    if (previous && target) {
      for (let d: DisplayObject | null = previous; d; d = d.parent) {
        if (entered.has(d)) {
          common = d;
          break;
        }
      }
    }

    if (previous) {
      buttonState(previous, "up");
      this.send("mouseOut", previous, p, down, true, target);
      for (let d: DisplayObject | null = previous; d && d !== common; d = d.parent) {
        this.send("rollOut", d, p, down, false, target);
      }
    }

    if (target) {
      buttonState(target, down && target === this.pressed ? "down" : "over");
      for (let d: DisplayObject | null = target; d && d !== common; d = d.parent) {
        this.send("rollOver", d, p, down, false, previous);
      }

      this.send("mouseOver", target, p, down, true, previous);
    }

    this.hover = target;
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
      // Ruffle's rule: within half a second and two pixels of the last press.
      const last = this.lastPress;
      const time = p.time ?? Number.NaN;
      const again =
        last !== null &&
        Math.abs(time - last.time) < 500 &&
        (p.x - last.x) ** 2 + (p.y - last.y) ** 2 < 4;
      const clicks = again ? last.clicks + 1 : 1;
      this.lastPress = { x: p.x, y: p.y, time, clicks };
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

      if (target && target === this.pressed && !p.canceled) {
        this.send("click", target, p, false);
      }

      this.pressed = null;
      this.held = false;
    }
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

/** Show state `state` of `d`, if it is an enabled button: the pointer moves a disabled one through none. */
function buttonState(d: DisplayObject, state: "up" | "over" | "down"): void {
  if (d instanceof ButtonObject && d.enabled) {
    d.setState(state);
  }
}
