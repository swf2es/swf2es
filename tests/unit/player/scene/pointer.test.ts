// The pointer, touches and wheel on the renderer's canvas (scene/pointer.ts),
// with a canvas and a page that stand in for the browser's: where an event
// lands on the stage the canvas shows, and which reach the player.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Player } from "../../../../packages/player/dist/player.js";
import { bindCanvasPointer } from "../../../../packages/player/dist/scene/pointer.js";

// The context menu bound with the pointer asks whether the canvas is in a shadow root.
(globalThis as { ShadowRoot?: unknown }).ShadowRoot ??= class {};

type Listener = (e: unknown) => void;

/** A listener map, as an element's or a window's. */
function target() {
  const listeners = new Map<string, Listener>();
  return {
    listeners,
    addEventListener: (type: string, f: Listener) => listeners.set(type, f),
    removeEventListener: (type: string) => listeners.delete(type),
  };
}

/**
 * A canvas `width` by `height` in an element at `rect`, styled by `style`
 * (object-fit fill, no borders, unless it says), on a page whose frames
 * wait in `frames` till a test runs them.
 */
function page(
  width: number,
  height: number,
  rect = { left: 0, top: 0, width, height },
  style: Record<string, unknown> = { objectFit: "fill" },
) {
  const frames: (() => void)[] = [];
  const window = {
    ...target(),
    getComputedStyle: () => style,
    requestAnimationFrame: (f: () => void) => frames.push(f),
    cancelAnimationFrame: (id: number) => {
      frames[id - 1] = () => {};
    },
  };
  const document = { ...target(), defaultView: window };
  const canvas = {
    ...target(),
    width,
    height,
    style: { cursor: "", touchAction: "" },
    ownerDocument: document,
    getRootNode: () => document,
    getBoundingClientRect: () => rect,
  };
  /** An event of `type` at the client point (x, y), on the canvas unless `over` is another element. */
  const fire = (type: string, x: number, y: number, init: object = {}, over: unknown = canvas) => {
    const on = ["pointermove", "pointerup", "pointercancel"].includes(type) ? window : canvas;
    const f = on.listeners.get(type);
    assert.ok(f, `a ${type} listener`);
    let prevented = false;
    f({
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 0,
      altKey: false,
      ctrlKey: false,
      shiftKey: false,
      timeStamp: 0,
      pointerType: "mouse",
      pointerId: 1,
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: 0,
      deltaY: 0,
      deltaMode: 0,
      composedPath: () => [over],
      preventDefault: () => {
        prevented = true;
      },
      ...init,
    });
    return prevented;
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, window, frames, fire };
}

const stage = (x: number, y: number, width: number, height: number) => ({
  bounds: { x, y, width, height },
});

test("a press lands on the stage the canvas shows, where the canvas is its target, till unbound", () => {
  const { canvas, fire } = page(200, 100);
  const calls: unknown[][] = [];
  const player = {
    pointer: {
      handle: (...args: unknown[]) => calls.push(args),
      post: () => {},
      flush: () => {},
      cursor: () => "default",
    },
  } as unknown as Player;
  const unbind = bindCanvasPointer(canvas, player, stage(0, 0, 100, 50));
  const press = { buttons: 1, altKey: true, timeStamp: 1234 };
  fire("pointerdown", 30, 20, press);
  assert.deepEqual(calls, [
    [
      "down",
      {
        x: 15,
        y: 10,
        button: 0,
        buttons: 1,
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
        time: 1234,
      },
    ],
  ]);

  // Over an element on top of the canvas, as a menu or a host's control, it is outside.
  fire("pointerdown", 30, 20, press, {});
  assert.equal(calls.length, 1);
  unbind();
  assert.equal(
    (canvas as unknown as ReturnType<typeof target>).listeners.has("pointerdown"),
    false,
  );
});

test("pointer moves are posted, flushed by a frame of their own where nothing else did", () => {
  const { canvas, frames, fire } = page(100, 100);
  const calls: string[] = [];
  const pointer = {
    captured: false,
    post: (p: { x: number }) => calls.push(`post ${p.x}`),
    flush: () => calls.push("flush"),
    handle: (type: string, p: { x: number }) => {
      calls.push(`${type} ${p.x}`);
      pointer.captured &&= type !== "up";
    },
    cursor: () => "default",
  };
  const player = { pointer } as unknown as Player;
  const unbind = bindCanvasPointer(canvas, player, stage(0, 0, 100, 100));
  const off = {};
  fire("pointermove", 1, 0);
  fire("pointermove", 2, 0);
  fire("pointerdown", 3, 0);
  assert.deepEqual(calls, ["post 1", "post 2", "down 3"]);
  assert.equal(frames.length, 1);
  frames[0]();
  assert.deepEqual(calls.slice(3), ["flush"]);

  // A move off the canvas is the player's only while it holds the mouse, and a release off it
  // after a press on it is a release, then, at the next move off it, the leave the press held
  // back, once.
  fire("pointermove", 150, 0, {}, off);
  pointer.captured = true;
  fire("pointermove", 160, 0, {}, off);
  fire("pointerup", 170, 0, {}, off);
  fire("pointermove", 180, 0, {}, off);
  fire("pointermove", 190, 0, {}, off);
  assert.deepEqual(calls.slice(4), ["post 160", "up 170", "leave 180"]);

  // A release outside that held nothing leaves nothing: the leave came as the pointer left.
  fire("pointerdown", 5, 0);
  fire("pointerup", 170, 0, {}, off);
  fire("pointermove", 180, 0, {}, off);
  // And one that pressed nothing on the canvas is not the player's.
  fire("pointerup", 170, 0, {}, off);
  assert.deepEqual(calls.slice(7), ["down 5", "up 170"]);
  frames[1]();

  // Unbound, a posted move is flushed, and its frame given back.
  fire("pointermove", 4, 0);
  unbind();
  frames[2]();
  assert.deepEqual(calls.slice(9), ["flush", "post 4", "flush"]);
});

test("touches go to the player's touches, the mouse's and a pen's alone to its pointer", () => {
  const { canvas, window, fire } = page(100, 100);
  const calls: string[] = [];
  const touch = (type: string, t: { x: number; id: number; primary: boolean; width: number }) =>
    calls.push(`touch ${type} ${t.x} ${t.id} ${t.primary} ${t.width}`);
  const player = {
    pointer: {
      post: () => {},
      flush: () => {},
      handle: (type: string, p: { x: number }) => calls.push(`mouse ${type} ${p.x}`),
      cursor: () => "default",
    },
    touch: {
      post: (t: { x: number; id: number; primary: boolean; width: number }) => touch("move", t),
      flush: () => {},
      handle: touch,
    },
  } as unknown as Player;
  const unbind = bindCanvasPointer(canvas, player, stage(0, 0, 200, 200));
  const at = (pointerType: string, pointerId = 1, isPrimary = true) => ({
    pointerType,
    pointerId,
    isPrimary,
    width: 3,
    height: 3,
    pressure: 0.5,
  });
  fire("pointerdown", 1, 0, at("touch"));
  fire("pointerdown", 2, 0, at("touch", 2, false));
  fire("pointermove", 3, 0, at("touch"));
  fire("pointerup", 4, 0, at("touch"));
  fire("pointerup", 5, 0, at("touch", 2, false), {});
  // A finger lifted leaves the canvas; the mouse it moved stays where it was.
  fire("pointerleave", 5, 0, at("touch"));
  fire("pointerdown", 6, 0, at("mouse"));
  fire("pointerdown", 7, 0, at("pen"));
  // A cancel ends a touch where it last was, wherever the browser says it is, once.
  fire("pointerdown", 8, 0, at("touch", 3));
  fire("pointercancel", 999, 999, { ...at("touch", 3), timeStamp: 1 }, {});
  fire("pointercancel", 999, 999, { ...at("touch", 3), timeStamp: 2 }, {});
  unbind();
  assert.equal(window.listeners.has("pointercancel"), false);
  // Stage units: the stage is twice the canvas, so are the contact's width and the points.
  assert.deepEqual(calls, [
    "touch begin 2 1 true 6",
    "touch begin 4 2 false 6",
    "touch move 6 1 true 6",
    "touch end 8 1 true 6",
    "touch end 10 2 false 6",
    "mouse down 12",
    "mouse down 14",
    "touch begin 16 3 true 6",
    "touch cancel 16 3 true 6",
  ]);
});

test("pointer positions are taken within the box CSS object-fit shows the canvas in", () => {
  // A 100 by 50 stage drawn at resolution 2, a 200 by 100 canvas, in a 400 by
  // 100 element with a 5 pixel border: a 390 by 90 content box from (15, 25).
  const border = "5px";
  const style = {
    objectFit: "contain",
    borderLeftWidth: border,
    borderRightWidth: border,
    borderTopWidth: border,
    borderBottomWidth: border,
  };
  const { canvas, fire } = page(200, 100, { left: 10, top: 20, width: 400, height: 100 }, style);
  const calls: [number, number][] = [];
  const player = {
    pointer: {
      handle: (_type: string, p: { x: number; y: number }) => calls.push([p.x, p.y]),
      post: (p: { x: number; y: number }) => calls.push([p.x, p.y]),
      flush: () => {},
      cursor: () => "default",
      onCursor: null,
    },
  } as unknown as Player;
  const unbind = bindCanvasPointer(canvas, player, stage(0, 0, 100, 50));
  const press = (clientX: number, clientY: number) => {
    fire("pointerdown", clientX, clientY, { buttons: 1 });
    return calls[calls.length - 1];
  };

  // contain and scale-down: 180 by 90, from x 120; cover: 390 by 195, from y -27.5;
  // none: 200 by 100, from (110, 20); fill: the content box itself.
  assert.deepEqual(press(120 + 45, 25), [25, 0]);
  style.objectFit = "scale-down";
  assert.deepEqual(press(120 + 45, 25), [25, 0]);
  style.objectFit = "cover";
  assert.deepEqual(press(15 + 195, -27.5 + 97.5), [50, 25]);
  style.objectFit = "none";
  assert.deepEqual(press(110 + 20, 20 + 10), [10, 5]);
  style.objectFit = "fill";
  assert.deepEqual(press(15 + 39, 25 + 9), [10, 5]);
  const moved = calls.length;
  fire("pointermove", 15 + 39, 25 + 9);
  assert.equal(calls.length, moved + 1);
  assert.deepEqual(calls.at(-1), [10, 5]);

  // The player's cursor shows from the bind, as it changes, and goes with unbind; a finger's
  // drags are the SWF's, not the page's pans and zooms, while bound.
  assert.equal(canvas.style.cursor, "default");
  assert.equal(canvas.style.touchAction, "none");
  const pointer = player.pointer as unknown as { onCursor: (c: string) => void };
  pointer.onCursor("pointer");
  assert.equal(canvas.style.cursor, "pointer");
  unbind();
  assert.equal(canvas.style.cursor, "");
  assert.equal(canvas.style.touchAction, "");
  assert.equal(pointer.onCursor, null);
});

test("the wheel reaches the player in Flash's lines, keeps the page from scrolling only where the SWF takes it, and leaves Ctrl's zoom to the page", () => {
  const { canvas, fire } = page(100, 100);
  const calls: string[] = [];
  let taken = true;
  const player = {
    pointer: {
      post: () => {},
      flush: () => {},
      cursor: () => "default",
      wheel: (p: { x: number }, delta: number) => {
        calls.push(`${p.x} ${delta}`);
        return taken;
      },
    },
  } as unknown as Player;
  const unbind = bindCanvasPointer(canvas, player, stage(0, 0, 200, 200));
  const turn = (deltaY: number, deltaMode = 0, ctrlKey = false) =>
    fire("wheel", 5, 5, { deltaY, deltaMode, ctrlKey });

  // A notch, however many pixels the browser makes it, is 3 lines, up positive.
  assert.equal(turn(100), true);
  turn(-100);
  turn(53);
  turn(200);
  turn(3, 1);
  // A touchpad's pixels add up: 100 of them are 3 lines.
  for (let i = 0; i < 4; i++) {
    turn(10);
  }

  // Where the SWF does not take it the page scrolls; with Ctrl, a pinch too, the page zooms
  // and the SWF hears nothing.
  taken = false;
  assert.equal(turn(100), false);
  taken = true;
  assert.equal(turn(100, 0, true), false);
  unbind();
  assert.equal((canvas as unknown as ReturnType<typeof target>).listeners.has("wheel"), false);
  assert.deepEqual(calls, [
    "10 -3",
    "10 3",
    "10 -3",
    "10 -6",
    "10 -3",
    "10 0",
    "10 0",
    "10 0",
    "10 -1",
    "10 -3",
  ]);
});

test("the stage shown is read as each event comes, past the authored stage and as it moves", () => {
  const { canvas, fire } = page(192, 144);
  const calls: [number, number][] = [];
  const player = {
    pointer: {
      handle: (_type: string, p: { x: number; y: number }) => calls.push([p.x, p.y]),
      post: () => {},
      flush: () => {},
      cursor: () => "default",
      onCursor: null,
    },
  } as unknown as Player;
  const shown = stage(-48, -24, 192, 144);
  const unbind = bindCanvasPointer(canvas, player, shown);
  fire("pointerdown", 0, 0);
  assert.deepEqual(calls.at(-1), [-48, -24]);
  fire("pointerdown", 124, 104);
  assert.deepEqual(calls.at(-1), [76, 80]);
  shown.bounds = { x: 0, y: 0, width: 192, height: 144 };
  fire("pointerdown", 124, 104);
  assert.deepEqual(calls.at(-1), [124, 104]);
  unbind();
});
