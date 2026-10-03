// Browser pointer input enters here; Flash chooses targets from its display
// list, while Pixi only supplies the pointer's position and buttons.
import { hitsOwnPoint, toStage } from "./bounds.js";
import {
  BitmapObject,
  ButtonObject,
  Container,
  type DisplayObject,
  ShapeObject,
  StaticTextObject,
} from "./display.js";
import { apply, invert } from "./geometry.js";
import { dispatchEvent } from "./playerglobal/flash/events/EventDispatcher.js";
import type { Scripting } from "./scripting.js";

export interface PointerState {
  x: number;
  y: number;
  button?: number;
  buttons?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

/** The topmost interactive object under a point, in stage coordinates. */
export function pointerTarget(
  stage: Container,
  x: number,
  y: number,
  width: number,
  height: number,
): DisplayObject | null {
  const interactive = (d: DisplayObject): boolean =>
    !(d instanceof ShapeObject || d instanceof BitmapObject || d instanceof StaticTextObject) &&
    !!d.object &&
    d.object.$mouseEnabled !== false;
  const pick = (d: DisplayObject): { hit: boolean; target: DisplayObject | null } => {
    if (!d.visible || d.clipDepth > 0 || d.maskOf) {
      return { hit: false, target: null };
    }

    // A disabled container with disabled children is transparent to mouse input.
    // Shapes and bitmaps still count as hits and pass the event to their parent.
    if (
      d instanceof Container &&
      d.object?.$mouseEnabled === false &&
      d.object.$mouseChildren === false
    ) {
      return { hit: false, target: null };
    }

    // A button is hit where its hit test state is, whatever state it shows,
    // and is the target itself, its states' objects never. The hit test
    // state is in no container: it is tested as the button's child.
    if (d instanceof ButtonObject) {
      const area = d.hitTestState;
      if (!area) {
        return { hit: false, target: null };
      }

      const parent = area.parent;
      area.parent = d;
      try {
        const hit = pick(area).hit;
        return { hit, target: hit && interactive(d) ? d : null };
      } finally {
        area.parent = parent;
      }
    }

    if (d instanceof Container) {
      for (let i = d.children.length - 1; i >= 0; i--) {
        const child = pick(d.children[i]);
        if (child.hit) {
          const target = d.object?.$mouseChildren === false ? null : child.target;
          return { hit: true, target: target ?? (interactive(d) ? d : null) };
        }
      }
    }

    const hit = hitsOwnPoint(d, x, y, stage);
    return { hit, target: hit && interactive(d) ? d : null };
  };

  if (x < 0 || y < 0 || x >= width || y >= height) {
    return null;
  }

  for (let i = stage.children.length - 1; i >= 0; i--) {
    const child = pick(stage.children[i]);
    if (child.hit) {
      return child.target ?? stage;
    }
  }

  return stage.object ? stage : null;
}

/** Mouse events on the player's display list, independent of a renderer. */
export class PointerInput {
  /** How many pointer events it has handled: each may run scripts and change a button's state. */
  handled = 0;
  private hover: DisplayObject | null = null;
  private pressed: DisplayObject | null = null;

  constructor(
    private readonly stage: Container,
    private readonly scripting: Scripting,
  ) {}

  private send(type: string, target: DisplayObject, p: PointerState, buttonDown: boolean): void {
    if (!target.object) {
      return;
    }

    const m = invert(toStage(target, this.stage));
    const [x, y] = m ? apply(m, p.x, p.y) : [Number.NaN, Number.NaN];
    const s = this.scripting;
    const event = s.rt.construct(
      s.rt.classNamed("flash.events::MouseEvent"),
      type,
      true,
      false,
      x,
      y,
      null,
      !!p.ctrlKey,
      !!p.altKey,
      !!p.shiftKey,
      buttonDown,
      0,
    );
    dispatchEvent(s, target.object, event);
  }

  handle(type: "move" | "down" | "up" | "leave", p: PointerState): void {
    this.handled++;
    const s = this.scripting;
    s.mouseStageX = p.x;
    s.mouseStageY = p.y;
    const target =
      type === "leave" ? null : pointerTarget(this.stage, p.x, p.y, s.stageWidth, s.stageHeight);
    const down = (p.buttons ?? 0) & 1 ? true : type === "down" && (p.button ?? 0) === 0;

    if (target !== this.hover) {
      if (this.hover) {
        buttonState(this.hover, "up");
        this.send("mouseOut", this.hover, p, down);
      }

      if (target) {
        buttonState(target, down && target === this.pressed ? "down" : "over");
        this.send("mouseOver", target, p, down);
      }

      this.hover = target;
    }

    if (type === "move") {
      if (target) {
        this.send("mouseMove", target, p, down);
      }
    } else if (type === "down" && (p.button ?? 0) === 0) {
      this.pressed = target;
      if (target) {
        buttonState(target, "down");
        this.send("mouseDown", target, p, true);
      }
    } else if (type === "up" && (p.button ?? 0) === 0) {
      if (target) {
        buttonState(target, "over");
        this.send("mouseUp", target, p, false);
      }

      if (target && target === this.pressed) {
        this.send("click", target, p, false);
      }

      this.pressed = null;
    }
  }
}

/** Show state `state` of `d`, if it is an enabled button: the pointer moves a disabled one through none. */
function buttonState(d: DisplayObject, state: "up" | "over" | "down"): void {
  if (d instanceof ButtonObject && d.enabled) {
    d.setState(state);
  }
}
