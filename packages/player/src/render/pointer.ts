// The pointer, touches and wheel on the canvas, taken to the player's stage:
// Pixi's events normalize the browser's, and Flash's display list, not
// Pixi's, chooses the target (PixiView.bindPointer).
import {
  type FederatedPointerEvent,
  type Container as PixiContainer,
  Rectangle,
  type Renderer,
} from "pixi.js";
import { canvasPoint, wheelLines } from "../input/canvas.js";
import type { PointerState } from "../input/pointer.js";
import type { TouchState } from "../input/touch.js";
import type { Player } from "../player.js";
import { bindContextMenu } from "./context-menu.js";

/**
 * Where a pointer event is on the SWF's stage. CSS `object-fit` shows the
 * canvas's pixels in a box of their own within its content box, letterboxed
 * by `contain`, cropped by `cover`: Pixi maps a point over the whole element
 * as `fill` would, so the point is taken within that box instead, centred
 * as the default `object-position` puts it, and then from the canvas's
 * pixels to the visible stage rectangle. `style` is the canvas's live
 * computed style, null where there is no DOM. A `size`, a touch's
 * contact, comes back in stage units after the point.
 */
function stagePoint(
  renderer: Renderer,
  player: Player,
  e: { clientX: number; clientY: number; global: { x: number; y: number } },
  style: CSSStyleDeclaration | null,
  viewport: { bounds: Rectangle | null } | undefined,
  size: { width: number; height: number } = { width: 0, height: 0 },
): [x: number, y: number, width: number, height: number] {
  const screen = renderer.screen;
  const bounds = viewport?.bounds;
  const stageWidth = bounds?.width ?? player.width;
  const stageHeight = bounds?.height ?? player.height;
  const toStage = (
    x: number,
    y: number,
    w: number,
    h: number,
    width = screen.width,
    height = screen.height,
  ) =>
    [
      (x * stageWidth) / width + (bounds?.x ?? 0),
      (y * stageHeight) / height + (bounds?.y ?? 0),
      (w * stageWidth) / width,
      (h * stageHeight) / height,
    ] as [number, number, number, number];
  const canvas = renderer.canvas as HTMLCanvasElement | undefined;
  if (!canvas?.getBoundingClientRect || !style) {
    return toStage(e.global.x, e.global.y, size.width, size.height);
  }

  const [cx, cy, sx, sy] = canvasPoint(canvas, style, e.clientX, e.clientY);
  // The canvas can already have resized while the renderer's screen still
  // describes its previous texture frame. Normalize against the pixels shown.
  return toStage(cx, cy, size.width / sx, size.height / sy, canvas.width, canvas.height);
}

/** Let Pixi normalize browser coordinates; Flash's display list chooses the target. */
export function bindPointer(
  renderer: Renderer,
  stage: PixiContainer,
  player: Player,
  viewport?: { bounds: Rectangle | null },
): () => void {
  stage.eventMode = "static";
  stage.hitArea = viewport?.bounds
    ? viewport.bounds.clone()
    : new Rectangle(0, 0, renderer.screen.width, renderer.screen.height);
  // The stage is Pixi's only target: its hit test would otherwise search
  // every child on each move, which on a crowded display list made each
  // frame a third longer while the mouse moved.
  const interactiveChildren = stage.interactiveChildren;
  stage.interactiveChildren = false;
  // A move is posted, handled when the player next advances or before the
  // next press, release, leave or key; a frame callback of its own handles
  // it where the host does not advance (a paused player, say).
  let frame = 0;
  const canvas = renderer.canvas as HTMLCanvasElement | undefined;
  // Live: read once, it follows the element's style as the page changes it.
  const style =
    canvas?.getBoundingClientRect && typeof getComputedStyle === "function"
      ? getComputedStyle(canvas)
      : null;
  const unbindMenu = canvas?.ownerDocument
    ? bindContextMenu(
        canvas,
        player,
        (e) => {
          const at = {
            clientX: e.clientX,
            clientY: e.clientY,
            global: { x: e.offsetX, y: e.offsetY },
          };
          const [x, y] = stagePoint(renderer, player, at, style, viewport);
          return [x, y];
        },
        () => viewport?.bounds ?? null,
      )
    : null;
  const flushSoon = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      player.pointer?.flush();
      player.touch?.flush();
    });
  };
  // Each touch's last point, which a cancel, whose own may be anywhere, ends at.
  const touches = new Map<number, TouchState>();
  // A touch goes to the player's touches, which move the mouse for the primary one.
  const touched = (type: "move" | "down" | "up" | "leave", e: FederatedPointerEvent) => {
    const touch = player.touch;
    // A lifted finger leaves the canvas too: the mouse it moved stays, as Flash's does.
    if (!touch || type === "leave") {
      return;
    }

    const [x, y, width, height] = stagePoint(renderer, player, e, style, viewport, e);
    const t: TouchState = {
      x,
      y,
      id: e.pointerId,
      primary: e.isPrimary,
      width,
      height,
      pressure: e.pressure,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      time: e.timeStamp,
    };
    if (type === "up") {
      touches.delete(t.id);
    } else {
      touches.set(t.id, t);
    }

    if (type === "move" && typeof requestAnimationFrame === "function") {
      touch.post(t);
      flushSoon();
      return;
    }

    touch.handle(type === "down" ? "begin" : type === "up" ? "end" : "move", t);
  };
  const send = (type: "move" | "down" | "up" | "leave") => (e: FederatedPointerEvent) => {
    if (e.pointerType === "touch") {
      touched(type, e);
      return;
    }

    const [x, y] = stagePoint(renderer, player, e, style, viewport);
    const p: PointerState = {
      x,
      y,
      button: e.button,
      buttons: e.buttons,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      time: e.timeStamp,
    };
    if (type === "move" && player.pointer && typeof requestAnimationFrame === "function") {
      player.pointer.post(p);
      flushSoon();
      return;
    }

    player.pointer?.handle(type, p);
  };
  const moved = send("move");
  const down = send("down");
  const up = send("up");
  const leave = send("leave");
  // Every move on the page: one over the canvas, and, while the mouse's
  // button is down after a press on it, one anywhere, as Flash keeps the
  // mouse until the release.
  const screen = renderer.screen;
  // A release outside after a press that held the mouse leaves it at the
  // next move outside, as Flash's mouseLeave comes.
  let leaveNext = false;
  const move = (e: FederatedPointerEvent) => {
    const { x, y } = e.global;
    const resolution = renderer.resolution || 1;
    const width = canvas?.width ? canvas.width / resolution : screen.width;
    const height = canvas?.height ? canvas.height / resolution : screen.height;
    const inside = x >= 0 && y >= 0 && x < width && y < height;
    if (inside || (e.pointerType !== "touch" && player.pointer?.captured)) {
      leaveNext = false;
      moved(e);
    } else if (leaveNext && e.pointerType !== "touch") {
      leaveNext = false;
      leave(e);
    }
  };
  const upOutside = (e: FederatedPointerEvent) => {
    const held = e.pointerType !== "touch" && !!player.pointer?.captured;
    up(e);
    leaveNext ||= held && !player.pointer?.captured;
  };
  stage.on("globalpointermove", move);
  stage.on("pointerdown", down);
  stage.on("pointerup", up);
  stage.on("pointerupoutside", upOutside);
  stage.on("pointerleave", leave);
  // Pixi listens for no cancel: the browser takes a touch back so, as for a
  // system gesture, and the touch ends where it last was, without its tap or click.
  const cancel = (e: Event) => {
    const t = touches.get((e as PointerEvent).pointerId);
    if (t && (e as PointerEvent).pointerType === "touch") {
      touches.delete(t.id);
      player.touch?.handle("cancel", { ...t, time: e.timeStamp });
    }
  };
  canvas?.addEventListener?.("pointercancel", cancel);
  // The wheel in Flash's lines (input/canvas.ts). The page scrolls unless the SWF takes the
  // wheel where the pointer is. With Ctrl, as a touchpad's pinch comes too, the page zooms and
  // the SWF hears nothing. Pixi listens passively.
  const left = { lines: 0 };
  const wheel = (e: WheelEvent) => {
    const pointer = player.pointer;
    if (!pointer || e.deltaY === 0 || e.ctrlKey) {
      return;
    }

    const delta = wheelLines(left, e);
    const at = { clientX: e.clientX, clientY: e.clientY, global: { x: e.offsetX, y: e.offsetY } };
    const [x, y] = stagePoint(renderer, player, at, style, viewport);
    const p: PointerState = {
      x,
      y,
      buttons: e.buttons,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      time: e.timeStamp,
    };
    if (pointer.wheel(p, delta)) {
      e.preventDefault();
    }
  };
  canvas?.addEventListener?.("wheel", wheel, { passive: false });
  // Pixi sets the canvas's cursor on every move, from its target's, which
  // is this stage: the player's cursor goes there, and through Pixi's own
  // setter now, which keeps Pixi's record of it right.
  const events = (
    renderer as {
      events?: { setCursor(mode: string | null): void; cursorStyles: Record<string, unknown> };
    }
  ).events;
  // Pixi's "default" is "inherit", which shows the page's cursor where the
  // page sets one; Flash's arrow, auto's or a forced one, is the arrow.
  const pixiDefault = events?.cursorStyles.default;
  if (events) {
    events.cursorStyles.default = "default";
  }

  const show = (cursor: string) => {
    stage.cursor = cursor;
    if (events) {
      events.setCursor(cursor);
    } else if (canvas?.style) {
      canvas.style.cursor = cursor;
    }
  };
  const pointer = player.pointer;
  if (pointer) {
    pointer.onCursor = show;
    show(pointer.cursor());
  }

  return () => {
    unbindMenu?.();
    // Pixi's own default back first, then the canvas left to it, as before the bind.
    if (events) {
      events.cursorStyles.default = pixiDefault;
    }

    if (pointer) {
      pointer.onCursor = null;
      stage.cursor = "default";
      if (canvas?.style) {
        canvas.style.cursor = "";
      }
    }

    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }

    player.pointer?.flush();
    player.touch?.flush();
    canvas?.removeEventListener?.("pointercancel", cancel);
    canvas?.removeEventListener?.("wheel", wheel);
    stage.off("globalpointermove", move);
    stage.off("pointerdown", down);
    stage.off("pointerup", up);
    stage.off("pointerupoutside", upOutside);
    stage.off("pointerleave", leave);
    stage.eventMode = "passive";
    stage.hitArea = null;
    stage.interactiveChildren = interactiveChildren;
  };
}
