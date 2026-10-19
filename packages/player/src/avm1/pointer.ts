// The pointer of an AVM1 movie, by AVM1's rules rather than AS3's (Ruffle's
// player.rs update_mouse_state, and Avm1Button's and MovieClip's mouse picks
// and event dispatches, at the corpus's commit; MIT OR Apache-2.0,
// Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors). Selectable fields,
// buttons and clips in button mode take it. An input first goes to every
// clip as its clip event (mouseMove, mouseDown, mouseUp); then the object
// under it is picked again and gets its button events: rolls as the hover
// moves, drags while the button is down, a press, and a release or a
// release outside.
import { ClipEvent } from "@swf2es/format";
import { hitsPoint, toStage } from "../display/bounds.js";
import {
  ButtonObject,
  type Container,
  type DisplayObject,
  MovieClip,
  TextObject,
} from "../display/display.js";
import { apply, invert } from "../display/geometry.js";
import {
  type Cursor,
  type Drag,
  dragTo,
  type Pointer,
  type PointerState,
} from "../input/pointer.js";
import { caretAt } from "../input/text-editor.js";
import type { Avm1 } from "./avm1.js";
import { stateOf } from "./globals/TextField.js";

type ButtonEvent = readonly [DisplayObject, number];

/** Where an object the pointer holds was: its parent, its depth and its character. */
interface Spot {
  parent: Container;
  depth: number | null;
  id: number | undefined;
}

export class Avm1Pointer implements Pointer {
  redraws = 0;
  onCursor: ((cursor: Cursor) => void) | null = null;
  private hover: DisplayObject | null = null;
  private pressed: DisplayObject | null = null;
  private hoverAt: Spot | null = null;
  private pressedAt: Spot | null = null;
  /** Whether the left button is down after a press here. */
  private held = false;
  /** Where the pointer last was over the player; null before it came, or once it left. */
  private last: PointerState | null = null;
  private moved: PointerState | null = null;
  private shown: Cursor = "default";
  private drag: Drag | null = null;
  private selection: { field: TextObject; anchor: number } | null = null;

  constructor(
    private readonly stage: Container,
    private readonly avm1: Avm1,
  ) {
    avm1.pointer = this;
  }

  /** One drag at a time: a new one takes over from any other. */
  startDrag(target: DisplayObject, lockCenter: boolean, bounds: number[] | null): void {
    const [left, top, right, bottom] = bounds ?? [];
    this.drag = {
      target,
      lockCenter,
      bounds: bounds
        ? {
            xMin: Math.min(left, right),
            yMin: Math.min(top, bottom),
            xMax: Math.max(left, right),
            yMax: Math.max(top, bottom),
          }
        : null,
      lastX: this.avm1.mouseX,
      lastY: this.avm1.mouseY,
    };
    this.dragged();
  }

  stopDrag(): void {
    this.dragged();
    this.drag = null;
  }

  /**
   * The dragged clip brought to where the pointer is, and its `_droptarget`
   * the topmost clip or button under the pointer, the dragged clip left
   * out, as Ruffle picks it; a drag of one taken off the stage ends.
   */
  private dragged(): void {
    const drag = this.drag;
    if (drag === null) {
      return;
    }

    const d = drag.target;
    if (!this.onStage(d)) {
      this.drag = null;
      return;
    }

    if (dragTo(this.stage, drag, this.avm1.mouseX, this.avm1.mouseY)) {
      this.redraws++;
    }

    if (d instanceof MovieClip) {
      const visible = d.visible;
      d.visible = false;
      try {
        this.avm1.dropTargets.set(d, this.pick(this.avm1.mouseX, this.avm1.mouseY, true));
      } finally {
        d.visible = visible;
      }
    }
  }

  get captured(): boolean {
    return this.held;
  }

  cursor(): Cursor {
    return this.shown;
  }

  post(p: PointerState): void {
    this.moved = p;
  }

  flush(): void {
    const p = this.moved;
    if (p) {
      this.handle("move", p);
    }
  }

  /**
   * The wheel over the player: a move to `p` first, then Mouse's listeners'
   * onMouseWheel with the delta and what is under the pointer. The SWF
   * takes it where Mouse has listeners; the page scrolls otherwise.
   */
  wheel(p: PointerState, delta: number): boolean {
    this.handle("move", p);
    if (delta === 0 || !this.avm1.input.mouseHeard) {
      return false;
    }

    this.avm1.input.mouseWheel(delta, this.hover);
    return true;
  }

  handle(type: "move" | "down" | "up" | "leave", p: PointerState): void {
    // A move posted before this input comes first; a move given now replaces it.
    if (type === "move") {
      this.moved = null;
    } else {
      this.flush();
    }

    this.replaced();

    // Left with the button up: nothing is under it. With the button down, Flash keeps the mouse.
    if (type === "leave") {
      if (!this.held) {
        this.last = null;
        this.send(this.hoverTo(null, []));
      }

      return;
    }

    const at = this.last;
    if (type === "move" && at && at.x === p.x && at.y === p.y) {
      return;
    }

    this.last = p;
    this.avm1.mouseX = p.x;
    this.avm1.mouseY = p.y;
    const left = (p.button ?? 0) === 0;
    if (type !== "move") {
      this.avm1.input.mouseButton(p.button ?? 0, type === "down");
    }

    // Every clip's clip event first, and what they queue runs, before the pick.
    if (type === "move") {
      this.avm1.clipEvent(ClipEvent.mouseMove);
    } else if (left) {
      this.avm1.clipEvent(type === "down" ? ClipEvent.mouseDown : ClipEvent.mouseUp);
    }

    this.dragged();

    // The button's state first, which the hover's events follow, as Ruffle has it.
    const held = this.held;
    if (left && type !== "move") {
      this.held = type === "down";
    }

    const events = this.hoverTo(this.pick(p.x, p.y), []);
    if (left && type === "down") {
      this.selection = null;
      const field = this.hover instanceof TextObject ? this.hover : null;
      if (field || this.avm1.focused instanceof TextObject) {
        this.avm1.focus(field);
      }

      if (field) {
        const position = this.textPosition(field, p.x, p.y);
        stateOf(field).selected = true;
        field.select(position, position);
        this.selection = { field, anchor: position };
      }

      this.pressed = this.hover;
      this.pressedAt = this.hoverAt;
      if (this.hover) {
        events.push([this.hover, ClipEvent.press]);
      }
    } else if (left && type === "up" && held) {
      this.selection = null;
      const pressed = this.pressed;
      const hover = this.hover;
      this.pressed = null;
      this.pressedAt = null;
      if (pressed && hover && same(pressed, hover)) {
        events.push([pressed, ClipEvent.release]);
      } else {
        // Released elsewhere, or after a press on nothing: what is under it is rolled over.
        if (pressed) {
          events.push([pressed, ClipEvent.releaseOutside]);
        }

        if (hover && !events.some(([d, e]) => d === hover && e === ClipEvent.rollOver)) {
          events.push([hover, ClipEvent.rollOver]);
        }
      }
    }

    const selection = this.selection;
    if (type === "move" && this.held && selection && this.onStage(selection.field)) {
      selection.field.select(selection.anchor, this.textPosition(selection.field, p.x, p.y));
      this.redraws++;
    }

    this.send(events);

    // After the input and what it ran, as Ruffle resets the focus's highlight.
    this.avm1.focusTracker.pointerInput(type, p.button ?? 0);
  }

  private textPosition(field: TextObject, x: number, y: number): number {
    const inverse = invert(toStage(field, this.stage));
    const [localX, localY] = inverse ? apply(inverse, x, y) : [0, 0];
    return caretAt(field, localX * 20, localY * 20);
  }

  /**
   * After a frame: what is under a pointer that has not moved, picked
   * again where nothing was or the hover was hidden or removed, as
   * Ruffle's update does, so a button that comes under an idle pointer
   * gets its roll over, and one hidden from under it its roll out.
   */
  frameEnded(): void {
    this.replaced();
    this.dragged();
    const p = this.last;
    const hover = this.hover;
    if (p === null || (hover?.visible && this.onStage(hover))) {
      return;
    }

    this.send(this.hoverTo(this.pick(p.x, p.y), []));
  }

  /**
   * The hover moved to `target`: with the button up, a roll out of what it
   * was over and a roll over of what it is over; with it down, a drag out
   * of the one and a drag over of the other, the pressed object's as the
   * pointer leaves it and comes back, any other's as a menu's items have
   * them, but while a script drags a clip (Ruffle's order: the pressed
   * object's drag over before the drag out of what the pointer left).
   */
  private hoverTo(target: DisplayObject | null, events: ButtonEvent[]): ButtonEvent[] {
    const hover = this.hover;
    if (target === hover) {
      return events;
    }

    if (!this.held) {
      if (hover) {
        events.push([hover, ClipEvent.rollOut]);
      }

      if (target) {
        events.push([target, ClipEvent.rollOver]);
      }
    } else {
      const pressed = this.pressed;
      const menu = this.drag === null;
      if (target && target === pressed) {
        events.push([target, ClipEvent.dragOver]);
      }

      if (hover && (hover === pressed || menu)) {
        events.push([hover, ClipEvent.dragOut]);
      }

      if (target && target !== pressed && menu) {
        events.push([target, ClipEvent.dragOver]);
      }
    }

    this.hover = target;
    this.hoverAt = target ? spotOf(target) : null;
    return events;
  }

  /**
   * A hover or a pressed object taken off the stage, a goto having made it
   * again at its depth, is the one made again, in its state, as Ruffle has
   * it: a button a press's goto remakes still takes the release.
   */
  private replaced(): void {
    this.hover = this.again(this.hover, this.hoverAt);
    this.pressed = this.again(this.pressed, this.pressedAt);
  }

  private again(d: DisplayObject | null, spot: Spot | null): DisplayObject | null {
    if (d === null || this.onStage(d)) {
      return d;
    }

    const found =
      spot && this.onStage(spot.parent)
        ? spot.parent.children.find(
            (c) => c !== d && c.depth === spot.depth && c.character?.id === spot.id,
          )
        : undefined;
    if (found instanceof ButtonObject && d instanceof ButtonObject && found.state !== d.state) {
      found.setState(d.state, false);
    }

    return found ?? null;
  }

  /**
   * The events to their objects: a hidden button up gets none, one not up
   * all, and a hidden clip only its release outside; one disabled gets
   * none, a button going up unless the event is to over, and the pointer
   * letting go of it, so that enabled again under the pointer it gets its
   * roll over (Ruffle's filter_clip_event and Avm1Button's). Then the
   * cursor follows what is under it.
   */
  private send(events: ButtonEvent[]): void {
    const kept: ButtonEvent[] = [];
    for (const event of events) {
      const [d, e] = event;
      const button = d instanceof ButtonObject ? d : null;
      if (!d.visible && (button ? button.state === "up" : e !== ClipEvent.releaseOutside)) {
        continue;
      }

      if (!this.avm1.input.flag(d, "enabled")) {
        if (button) {
          this.letGo(button, e);
        }

        continue;
      }

      kept.push(event);
    }

    if (kept.length > 0) {
      this.redraws++;
      this.avm1.input.buttonEvents(kept);
    }

    this.updateCursor();
  }

  /** A disabled button let go of, up unless the event would show it over. */
  private letGo(button: ButtonObject, e: number): void {
    if (this.hover === button) {
      this.hover = null;
      this.hoverAt = null;
    }

    if (this.pressed === button) {
      this.pressed = null;
      this.pressedAt = null;
    }

    const over = e === ClipEvent.rollOver || e === ClipEvent.release || e === ClipEvent.dragOut;
    if (!over && button.state !== "up") {
      button.setState("up", false);
      this.redraws++;
    }
  }

  /**
   * What takes the pointer at (x, y) on the stage: the topmost button or
   * clip in button mode there, searched from the topmost level down
   * (Ruffle's mouse_pick_avm1).
   */
  private pick(x: number, y: number, any = false): DisplayObject | null {
    const children = this.stage.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const found = this.pickIn(children[i], x, y, any);
      if (found) {
        return found;
      }
    }

    return null;
  }

  /**
   * What `d` picks at (x, y): with `any`, as `_droptarget` names it, also
   * a clip whose own drawing is there, the topmost of what is in it
   * deciding, and one in button mode by its own drawing, not its hitArea.
   */
  private pickIn(d: DisplayObject, x: number, y: number, any = false): DisplayObject | null {
    if (!d.visible || d.clipDepth > 0 || d.maskOf) {
      return null;
    }

    if (!any && d instanceof TextObject) {
      return d.selectable && hitsPoint(d, x, y, false, this.stage) ? d : null;
    }

    // A button: what is in the state it shows first, a clip in button mode
    // there taking the pointer from it, then its hit test state, tested as
    // its child, whatever state it shows.
    if (d instanceof ButtonObject) {
      const shown = this.pickChildren(d, x, y, any);
      if (shown) {
        return shown;
      }

      const area = d.hitTestState;
      if (!area) {
        return null;
      }

      const parent = area.parent;
      area.parent = d;
      try {
        return hitsPoint(area, x, y, true, this.stage) ? d : null;
      } finally {
        area.parent = parent;
      }
    }

    if (!(d instanceof MovieClip)) {
      return null;
    }

    // A clip in button mode takes the pointer itself, its children's
    // buttons with it, where its hitArea, or else it, is drawn; where it
    // misses, its children may still be hit.
    if (this.avm1.input.buttonMode(d)) {
      const area = any ? null : this.avm1.input.hitArea(d);
      if (hitsPoint(area ?? d, x, y, true, this.stage)) {
        return d;
      }
    }

    return this.pickChildren(d, x, y, any);
  }

  private pickChildren(d: Container, x: number, y: number, any: boolean): DisplayObject | null {
    const children = d.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      const found =
        child instanceof MovieClip ||
        child instanceof ButtonObject ||
        (!any && child instanceof TextObject)
          ? this.pickIn(child, x, y, any)
          : any && d instanceof MovieClip && this.drawnAt(child, x, y)
            ? d
            : null;
      if (found) {
        return found;
      }
    }

    return null;
  }

  /** Whether `d`, a shape or anything but a clip or button, draws at (x, y), shown and no mask. */
  private drawnAt(d: DisplayObject, x: number, y: number): boolean {
    return d.visible && d.clipDepth === 0 && !d.maskOf && hitsPoint(d, x, y, true, this.stage);
  }

  /** Whether `d` is still on the stage, not taken off since it was picked. */
  private onStage(d: DisplayObject): boolean {
    let o: DisplayObject | null = d;
    while (o && o !== this.stage) {
      o = o.parent;
    }

    return o === this.stage;
  }

  /**
   * The hand over a button whose useHandCursor and enabled are true, and
   * over a clip whose nearest ancestor in button mode, itself perhaps, has
   * them so; the arrow elsewhere, and nothing while Mouse.hide holds.
   */
  updateCursor(): void {
    let cursor: Cursor = this.avm1.input.mouseShown ? "default" : "none";
    const hover = this.avm1.input.mouseShown ? this.hover : null;
    if (hover instanceof TextObject) {
      cursor = "text";
    } else if (hover instanceof ButtonObject) {
      cursor = this.hand(hover) ? "pointer" : "default";
    } else {
      for (let o = hover; o && o !== this.stage; o = o.parent) {
        if (o instanceof MovieClip && this.avm1.input.buttonMode(o)) {
          cursor = this.hand(o) ? "pointer" : "default";
          break;
        }
      }
    }

    if (cursor !== this.shown) {
      this.shown = cursor;
      this.onCursor?.(cursor);
    }
  }

  private hand(d: DisplayObject): boolean {
    return this.avm1.input.flag(d, "useHandCursor") && this.avm1.input.flag(d, "enabled");
  }
}

function spotOf(d: DisplayObject): Spot | null {
  return d.parent ? { parent: d.parent, depth: d.depth, id: d.character?.id } : null;
}

/**
 * Whether a release is on what was pressed: the same object, or one a goto
 * made again in its place, at its depth, of its character, as Ruffle's
 * check_display_object_equality has it.
 */
function same(a: DisplayObject, b: DisplayObject): boolean {
  return (
    a === b ||
    (a.parent === b.parent &&
      a.depth === b.depth &&
      a.character !== null &&
      a.character?.id === b.character?.id)
  );
}
