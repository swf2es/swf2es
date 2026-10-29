// The pointer, touches and wheel on the own renderer's canvas, taken to the
// player's stage from the browser's events themselves, as the Pixi view's
// binding (render/pointer.ts) takes them through Pixi's: Flash's display
// list chooses the target, and the same rules hold for moves outside the
// canvas, releases outside it, touches, the wheel, the cursor and the menu.
import { canvasPoint, wheelLines } from "../input/canvas.js";
import type { PointerState } from "../input/pointer.js";
import type { TouchState } from "../input/touch.js";
import type { Player } from "../player.js";
import { bindContextMenu } from "../render/context-menu.js";

/** The part of the stage the canvas shows, read as each event comes, as the view may be zoomed. */
export interface ShownStage {
  readonly bounds: { x: number; y: number; width: number; height: number };
}

/**
 * The mouse, touches and wheel on `canvas` to `player`'s stage, of which
 * the canvas shows `shown`; what undoes it. An event over the canvas
 * counts where the canvas is its target, as Pixi's do: over an element on
 * top of it, as a menu or a host's control, it is outside.
 */
export function bindCanvasPointer(
  canvas: HTMLCanvasElement,
  player: Player,
  shown: ShownStage,
): () => void {
  const page = canvas.ownerDocument.defaultView as Window;
  // Live: read once, it follows the element's style as the page changes it.
  const style = page.getComputedStyle(canvas);
  // A point on the stage, a touch's size there, and whether it is over the canvas's pixels.
  const at: [x: number, y: number, width: number, height: number, inside: boolean] = [
    0,
    0,
    0,
    0,
    false,
  ];
  const place = (e: MouseEvent, w = 0, h = 0) => {
    const [cx, cy, sx, sy] = canvasPoint(canvas, style, e.clientX, e.clientY);
    const bounds = shown.bounds;
    const kx = bounds.width / canvas.width;
    const ky = bounds.height / canvas.height;
    at[0] = cx * kx + bounds.x;
    at[1] = cy * ky + bounds.y;
    at[2] = (w / sx) * kx;
    at[3] = (h / sy) * ky;
    at[4] = e.target === canvas && cx >= 0 && cy >= 0 && cx < canvas.width && cy < canvas.height;
    return at;
  };

  // A move is posted, handled when the player next advances or before the
  // next press, release, leave or key; a frame callback of its own handles
  // it where the host does not advance (a paused player, say).
  let frame = 0;
  const flushSoon = () => {
    frame ||= page.requestAnimationFrame(() => {
      frame = 0;
      player.pointer?.flush();
      player.touch?.flush();
    });
  };
  const unbindMenu = bindContextMenu(
    canvas,
    player,
    (e) => {
      const [x, y] = place(e);
      return [x, y];
    },
    () => shown.bounds,
  );

  // Each touch's last point, which a cancel, whose own may be anywhere, ends at.
  const touches = new Map<number, TouchState>();
  const touched = (type: "move" | "down" | "up", e: PointerEvent) => {
    const touch = player.touch;
    if (!touch) {
      return;
    }

    const [x, y, width, height] = place(e, e.width, e.height);
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

    if (type === "move") {
      touch.post(t);
      flushSoon();
      return;
    }

    touch.handle(type === "down" ? "begin" : "end", t);
  };
  // The mouse's or a pen's, at the point `place` last found.
  const send = (type: "move" | "down" | "up" | "leave", e: PointerEvent) => {
    const p: PointerState = {
      x: at[0],
      y: at[1],
      button: e.button,
      buttons: e.buttons,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      time: e.timeStamp,
    };
    if (type === "move" && player.pointer) {
      player.pointer.post(p);
      flushSoon();
      return;
    }

    player.pointer?.handle(type, p);
  };

  // Every move on the page: one over the canvas, and, while the mouse's button is down after a
  // press on it, one anywhere, as Flash keeps the mouse until the release. A release outside after
  // a press that held the mouse leaves it at the next move outside, as Flash's mouseLeave comes.
  // A lifted finger leaves the canvas too, as a touch: the mouse it moved stays, as Flash's does.
  const pressed = new Set<number>();
  let leaveNext = false;
  const move = (e: PointerEvent) => {
    const touch = e.pointerType === "touch";
    const inside = place(e, e.width, e.height)[4];
    if (touch) {
      if (inside || pressed.has(e.pointerId)) {
        touched("move", e);
      }

      return;
    }

    if (inside || player.pointer?.captured) {
      leaveNext = false;
      send("move", e);
    } else if (leaveNext) {
      leaveNext = false;
      send("leave", e);
    }
  };
  // A press over the stage the canvas shows: in a letterbox's bars it is on no stage.
  const down = (e: PointerEvent) => {
    if (!place(e, e.width, e.height)[4]) {
      return;
    }

    pressed.add(e.pointerId);
    if (e.pointerType === "touch") {
      touched("down", e);
    } else {
      send("down", e);
    }
  };
  // A release over the canvas, or outside it after a press on it.
  const up = (e: PointerEvent) => {
    const inside = place(e, e.width, e.height)[4];
    const ours = pressed.delete(e.pointerId);
    if (!inside && !ours) {
      return;
    }

    if (e.pointerType === "touch") {
      touched("up", e);
      return;
    }

    const held = !inside && !!player.pointer?.captured;
    send("up", e);
    leaveNext ||= held && !player.pointer?.captured;
  };
  const leave = (e: PointerEvent) => {
    if (e.pointerType !== "touch") {
      place(e);
      send("leave", e);
    }
  };
  // The browser takes a touch back so, as for a system gesture, and the touch ends where it last
  // was, without its tap or click. A mouse's cancel, as a native drag starts, leaves its press:
  // its release outside still comes to the player.
  const cancel = (e: PointerEvent) => {
    if (e.pointerType !== "touch") {
      return;
    }

    pressed.delete(e.pointerId);
    const t = touches.get(e.pointerId);
    if (t) {
      touches.delete(t.id);
      player.touch?.handle("cancel", { ...t, time: e.timeStamp });
    }
  };

  // The wheel in Flash's lines (input/canvas.ts). The page scrolls unless the SWF takes the wheel
  // where the pointer is. With Ctrl, as a touchpad's pinch comes too, the page zooms and the SWF
  // hears nothing.
  const left = { lines: 0 };
  const wheel = (e: WheelEvent) => {
    const pointer = player.pointer;
    if (!pointer || e.deltaY === 0 || e.ctrlKey) {
      return;
    }

    const delta = wheelLines(left, e);
    const [x, y] = place(e);
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

  page.addEventListener("pointermove", move);
  canvas.addEventListener("pointerdown", down);
  page.addEventListener("pointerup", up);
  canvas.addEventListener("pointerleave", leave);
  page.addEventListener("pointercancel", cancel);
  canvas.addEventListener("wheel", wheel, { passive: false });
  // A finger's drags are the SWF's, not the page's pans and zooms, as Pixi's events keep them.
  const touchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";
  // Flash's arrow, auto's or a forced one, is the arrow, not the page's cursor.
  const pointer = player.pointer;
  if (pointer) {
    pointer.onCursor = (cursor) => {
      canvas.style.cursor = cursor;
    };
    canvas.style.cursor = pointer.cursor();
  }

  return () => {
    unbindMenu();
    if (pointer) {
      pointer.onCursor = null;
      canvas.style.cursor = "";
    }

    canvas.style.touchAction = touchAction;
    if (frame) {
      page.cancelAnimationFrame(frame);
      frame = 0;
    }

    player.pointer?.flush();
    player.touch?.flush();
    page.removeEventListener("pointermove", move);
    canvas.removeEventListener("pointerdown", down);
    page.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointerleave", leave);
    page.removeEventListener("pointercancel", cancel);
    canvas.removeEventListener("wheel", wheel);
  };
}
