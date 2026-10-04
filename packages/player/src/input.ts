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

/**
 * What a pick finds: an interactive object hit, a hit that goes up to the
 * first ancestor with mouseEnabled, or nothing.
 */
const PROPAGATE = "propagate";
type Pick = DisplayObject | typeof PROPAGATE | null;

/** An InteractiveObject's kind: what picks for itself, rather than through its parent. */
const isInteractive = (d: DisplayObject): boolean =>
  !(d instanceof ShapeObject || d instanceof BitmapObject || d instanceof StaticTextObject);

const mouseEnabled = (d: DisplayObject): boolean => !!d.object && d.object.$mouseEnabled !== false;

/** `d` itself where it takes the pointer, else the hit goes on to its parent. */
const own = (d: DisplayObject): Pick => (mouseEnabled(d) ? d : PROPAGATE);

/**
 * The object under a point, in stage coordinates, as Flash picks it
 * (Ruffle's `mouse_pick_avm2`): within a container, its interactive
 * children first, topmost first, then the rest. A hit on artwork, or on
 * a child whose mouseEnabled is false, goes to the nearest ancestor that
 * takes the pointer; one that goes up is kept while the search goes on,
 * so a disabled field over a button leaves the button its clicks.
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

    return hitsOwnPoint(d, x, y, stage);
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
      return hitsOwnPoint(d, x, y, stage) ? own(d) : null;
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

    if (propagated) {
      return own(d);
    }

    for (let i = children.length - 1; i >= 0; i--) {
      if (!isInteractive(children[i]) && drawn(children[i])) {
        return own(d);
      }
    }

    return hitsOwnPoint(d, x, y, stage) ? own(d) : null;
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
