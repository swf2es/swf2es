// The pointer, touches and wheel on the own renderer's canvas, taken to the
// player's stage from the browser's events themselves, as the Pixi view's
// binding (render/pointer.ts) takes them through Pixi's: Flash's display
// list chooses the target, and the same rules hold for moves outside the
// canvas, releases outside it, touches, the wheel, the cursor and the menu.
import type { PointerState } from "../input/pointer.js";
import type { TouchState } from "../input/touch.js";
import type { Player } from "../player.js";
import { bindContextMenu } from "../render/context-menu.js";

/** The part of the stage the canvas shows, where a host shows less than all of it. */
export interface ShownStage {
  bounds: { x: number; y: number; width: number; height: number } | null;
}

/**
 * Where a client point lies on the canvas's pixels. CSS `object-fit` shows
 * them in a box of their own within the content box, letterboxed by
 * `contain`, cropped by `cover`, centred as the default `object-position`
 * puts it. Also the CSS pixels a canvas pixel spans each way.
 */
function canvasPoint(
  canvas: HTMLCanvasElement,
  style: CSSStyleDeclaration,
  clientX: number,
  clientY: number,
): [x: number, y: number, sx: number, sy: number] {
  // The content box: the element's rectangle within its borders and padding.
  const px = (v: string | undefined) => Number.parseFloat(v ?? "") || 0;
  const rect = canvas.getBoundingClientRect();
  let left = rect.left + px(style.borderLeftWidth) + px(style.paddingLeft);
  let top = rect.top + px(style.borderTopWidth) + px(style.paddingTop);
  const width =
    rect.width -
    px(style.borderLeftWidth) -
    px(style.paddingLeft) -
    px(style.borderRightWidth) -
    px(style.paddingRight);
  const height =
    rect.height -
    px(style.borderTopWidth) -
    px(style.paddingTop) -
    px(style.borderBottomWidth) -
    px(style.paddingBottom);

  let sx = width / canvas.width;
  let sy = height / canvas.height;
  const fit = style.objectFit;
  if (fit === "contain" || fit === "scale-down" || fit === "cover" || fit === "none") {
    let scale = fit === "cover" ? Math.max(sx, sy) : fit === "none" ? 1 : Math.min(sx, sy);
    if (fit === "scale-down") {
      scale = Math.min(scale, 1);
    }

    left += (width - canvas.width * scale) / 2;
    top += (height - canvas.height * scale) / 2;
    sx = scale;
    sy = scale;
  }

  return [(clientX - left) / sx, (clientY - top) / sy, sx, sy];
}

/**
 * The mouse, touches and wheel on `canvas` to `player`'s stage, which the
 * canvas shows whole or, where `shown` says, a part of; what undoes it.
 */
export function bindCanvasPointer(
  canvas: HTMLCanvasElement,
  player: Player,
  shown?: ShownStage,
): () => void {
  const page = canvas.ownerDocument.defaultView as Window;
  // Live: read once, it follows the element's style as the page changes it.
  const style = page.getComputedStyle(canvas);
  /** A client point on the stage, inside the canvas or not, and a touch's size there. */
  const stagePoint = (
    clientX: number,
    clientY: number,
    w = 0,
    h = 0,
  ): [x: number, y: number, width: number, height: number, inside: boolean] => {
    const [cx, cy, sx, sy] = canvasPoint(canvas, style, clientX, clientY);
    const bounds = shown?.bounds;
    const kx = (bounds?.width ?? player.width) / canvas.width;
    const ky = (bounds?.height ?? player.height) / canvas.height;
    const inside = cx >= 0 && cy >= 0 && cx < canvas.width && cy < canvas.height;
    return [
      cx * kx + (bounds?.x ?? 0),
      cy * ky + (bounds?.y ?? 0),
      (w / sx) * kx,
      (h / sy) * ky,
      inside,
    ];
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
      const [x, y] = stagePoint(e.clientX, e.clientY);
      return [x, y];
    },
    () => shown?.bounds ?? null,
  );

  // Each touch's last point, which a cancel, whose own may be anywhere, ends at.
  const touches = new Map<number, TouchState>();
  const touched = (type: "move" | "down" | "up" | "leave", e: PointerEvent) => {
    const touch = player.touch;
    // A lifted finger leaves the canvas too: the mouse it moved stays, as Flash's does.
    if (!touch || type === "leave") {
      return;
    }

    const [x, y, width, height] = stagePoint(e.clientX, e.clientY, e.width, e.height);
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

    touch.handle(type === "down" ? "begin" : type === "up" ? "end" : "move", t);
  };
  const send = (type: "move" | "down" | "up" | "leave", e: PointerEvent) => {
    if (e.pointerType === "touch") {
      touched(type, e);
      return;
    }

    const [x, y] = stagePoint(e.clientX, e.clientY);
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
  const pressed = new Set<number>();
  let leaveNext = false;
  const move = (e: PointerEvent) => {
    const inside = stagePoint(e.clientX, e.clientY)[4];
    if (inside || (e.pointerType !== "touch" && player.pointer?.captured)) {
      leaveNext = false;
      send("move", e);
    } else if (leaveNext && e.pointerType !== "touch") {
      leaveNext = false;
      send("leave", e);
    }
  };
  const down = (e: PointerEvent) => {
    pressed.add(e.pointerId);
    send("down", e);
  };
  // A release over the canvas, or outside it after a press on it.
  const up = (e: PointerEvent) => {
    const inside = stagePoint(e.clientX, e.clientY)[4];
    const ours = pressed.delete(e.pointerId);
    if (!inside && !ours) {
      return;
    }

    const held = !inside && e.pointerType !== "touch" && !!player.pointer?.captured;
    send("up", e);
    leaveNext ||= held && !player.pointer?.captured;
  };
  const leave = (e: PointerEvent) => {
    send("leave", e);
  };
  // The browser takes a touch back so, as for a system gesture, and the touch ends where it last
  // was, without its tap or click.
  const cancel = (e: PointerEvent) => {
    pressed.delete(e.pointerId);
    const t = touches.get(e.pointerId);
    if (t && e.pointerType === "touch") {
      touches.delete(t.id);
      player.touch?.handle("cancel", { ...t, time: e.timeStamp });
    }
  };

  // The wheel in Flash's lines, up positive: 3 a notch, Flash's delta on Windows. A browser gives
  // a notch as 3 lines, or as about 100 pixels, fewer where the page is zoomed or the screen
  // scaled, and several at once as their multiple; a touchpad's few pixels at a time add up, 100
  // to 3 lines. The page scrolls unless the SWF takes the wheel where the pointer is. With Ctrl,
  // as a touchpad's pinch comes too, the page zooms and the SWF hears nothing.
  let lines = 0;
  const wheel = (e: WheelEvent) => {
    const pointer = player.pointer;
    if (!pointer || e.deltaY === 0 || e.ctrlKey) {
      return;
    }

    const size = Math.abs(e.deltaY);
    if (e.deltaMode !== 0) {
      lines = -e.deltaY * (e.deltaMode === 2 ? 3 : 1);
    } else if (size >= 50) {
      lines = -Math.sign(e.deltaY) * 3 * Math.max(1, Math.round(size / 100));
    } else {
      lines -= (e.deltaY * 3) / 100;
    }

    const delta = Math.trunc(lines);
    lines -= delta;
    const [x, y] = stagePoint(e.clientX, e.clientY);
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
  canvas.addEventListener("pointercancel", cancel);
  canvas.addEventListener("wheel", wheel, { passive: false });
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
    canvas.removeEventListener("pointercancel", cancel);
    canvas.removeEventListener("wheel", wheel);
  };
}
