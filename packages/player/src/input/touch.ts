// Touches enter here, a point at a time, as the browser's pointer events
// give them. The primary touch moves the mouse, as Flash moves it for
// the first finger down whatever Multitouch.inputMode is, and in
// touchPoint mode every touch is a TouchEvent's too: over, out and rolls
// as the point moves on and off objects, then its begin, move or end,
// and a tap where it ends on the object it began on. Each step's touch
// events come before its mouse events (docs/architecture.md, Touch).
import { toStage } from "../display/bounds.js";
import type { Container, DisplayObject } from "../display/display.js";
import { apply, invert } from "../display/geometry.js";
import { dispatchEvent } from "../scripting/events.js";
import type { Scripting } from "../scripting.js";
import { type PointerInput, type PointerState, pointerTarget } from "./pointer.js";

export interface TouchState extends PointerState {
  /** The browser's pointerId, which TouchEvent.touchPointID reports. */
  id: number;
  /** Whether it is the first of the touches down at once, which moves the mouse. */
  primary: boolean;
  /** The contact's size, in stage units. */
  width?: number;
  height?: number;
  /** The contact's force, 0 to 1. */
  pressure?: number;
}

interface Point {
  /** What the point is over, as a mouse hovers. */
  over: DisplayObject | null;
  /** What it began on, which a tap must end on. */
  began: DisplayObject | null;
}

export class TouchInput {
  /** How many touch events may show before the next frame: a begin or an end, as a press. */
  redraws = 0;
  private readonly points = new Map<number, Point>();
  /** Each point's latest move, handled at the next flush as the pointer's are. */
  private readonly moved = new Map<number, TouchState>();
  /** The point that moves the mouse, until it ends. */
  private primary: number | null = null;

  constructor(
    private readonly stage: Container,
    private readonly scripting: Scripting,
    private readonly pointer: PointerInput,
  ) {}

  /** A move to handle at the next flush, as PointerInput.post. */
  post(t: TouchState): void {
    this.moved.set(t.id, t);
  }

  flush(): void {
    if (this.moved.size === 0) {
      return;
    }

    const moves = [...this.moved.values()];
    this.moved.clear();
    for (const t of moves) {
      this.handle("move", t);
    }
  }

  /** A touch begun, moved, lifted or taken back by the browser ("cancel"), which ends it without a tap or a click. */
  handle(type: "begin" | "move" | "end" | "cancel", t: TouchState): void {
    if (type === "move") {
      this.moved.delete(t.id);
    } else {
      this.flush();
    }

    let point = this.points.get(t.id);
    if (type === "begin") {
      point = { over: null, began: null };
      this.points.set(t.id, point);
      // The browser's primary, as Flash's: the first finger down while none was.
      if (t.primary) {
        this.primary = t.id;
      }
    }

    // A point whose begin the player missed, as one pressed before it bound.
    if (!point) {
      return;
    }

    const primary = this.primary === t.id;
    const s = this.scripting;
    if (s.inputMode === "touchPoint") {
      this.touchEvents(type, t, point, primary);
    }

    if (primary && (s.inputMode !== "touchPoint" || s.mapTouchToMouse)) {
      this.mouse(type, t);
    }

    if (type === "end" || type === "cancel") {
      this.points.delete(t.id);
      if (primary) {
        this.primary = null;
      }
    }
  }

  /** The mouse events of the primary touch: a press is a move there and a press, as a mouse's would be. */
  private mouse(type: "begin" | "move" | "end" | "cancel", t: TouchState): void {
    const p: PointerState = {
      x: t.x,
      y: t.y,
      button: 0,
      buttons: type === "begin" || type === "move" ? 1 : 0,
      altKey: t.altKey,
      ctrlKey: t.ctrlKey,
      shiftKey: t.shiftKey,
      time: t.time,
    };
    switch (type) {
      case "begin":
        // Flash moves the mouse there first, if it was elsewhere (Flash Player 32, under a
        // browser's touch emulation).
        if (t.x !== this.scripting.mouseStageX || t.y !== this.scripting.mouseStageY) {
          this.pointer.handle("move", { ...p, buttons: 0 });
        }

        this.pointer.handle("down", p);
        break;
      case "move":
        this.pointer.handle("move", p);
        break;
      default:
        this.pointer.handle("up", { ...p, canceled: type === "cancel" });
    }
  }

  private touchEvents(
    type: "begin" | "move" | "end" | "cancel",
    t: TouchState,
    point: Point,
    primary: boolean,
  ): void {
    const s = this.scripting;
    const target = pointerTarget(this.stage, t.x, t.y, s.stageWidth, s.stageHeight);
    this.hover(point, target, t, primary);
    if (type === "move") {
      if (target) {
        this.send("touchMove", target, t, primary);
      }

      return;
    }

    this.redraws++;
    if (type === "begin") {
      point.began = target;
      // A touch's begin and end are a user's gesture, as a press and a release are.
      if (target) {
        s.clipboard.gesture(() => this.send("touchBegin", target, t, primary));
      }

      return;
    }

    const canceled = type === "cancel";
    s.clipboard.gesture(() => {
      if (target) {
        this.send("touchEnd", target, t, primary);
      }

      if (target && target === point.began && !canceled) {
        this.send("touchTap", target, t, primary);
      }
    });
    // A lifted finger is over nothing any more, unlike a mouse.
    this.hover(point, null, t, primary);
  }

  /** Move the point's hover to `target`: out and roll outs from what it was over, roll overs and over on what it is. */
  private hover(point: Point, target: DisplayObject | null, t: TouchState, primary: boolean): void {
    const previous = point.over;
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
      this.send("touchOut", previous, t, primary, true, target);
      for (let d: DisplayObject | null = previous; d && d !== common; d = d.parent) {
        this.send("touchRollOut", d, t, primary, false, target);
      }
    }

    if (target) {
      for (let d: DisplayObject | null = target; d && d !== common; d = d.parent) {
        this.send("touchRollOver", d, t, primary, false, previous);
      }

      this.send("touchOver", target, t, primary, true, previous);
    }

    point.over = target;
  }

  private send(
    type: string,
    target: DisplayObject,
    t: TouchState,
    primary: boolean,
    bubbles = true,
    related: DisplayObject | null = null,
  ): void {
    if (!target.object) {
      return;
    }

    const m = invert(toStage(target, this.stage));
    const [x, y] = m ? apply(m, t.x, t.y) : [Number.NaN, Number.NaN];
    const s = this.scripting;
    const event = s.rt.construct(
      s.rt.classNamed("flash.events::TouchEvent"),
      type,
      bubbles,
      false,
      t.id,
      primary,
      x,
      y,
      t.width ?? Number.NaN,
      t.height ?? Number.NaN,
      t.pressure ?? Number.NaN,
      related?.object ?? null,
      !!t.ctrlKey,
      !!t.altKey,
      !!t.shiftKey,
    );
    dispatchEvent(s, target.object, event);
  }
}
