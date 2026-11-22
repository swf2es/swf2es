import assert from "node:assert/strict";
import { test } from "node:test";
import { bindMouseLock } from "../../../../packages/player/dist/scene/mouse-lock.js";
import { FullScreen } from "../../../../packages/player/dist/scripting/full-screen.js";
import type { Scripting } from "../../../../packages/player/dist/scripting.js";

/** The canvas is in a shadow root. Only that root identifies the actual lock owner. */
function binding(request: () => Promise<void> | void) {
  const stage = new FullScreen({} as Scripting, null);
  const root = { pointerLockElement: null as object | null };
  const window = Object.assign(new EventTarget(), {
    navigator: { userActivation: { isActive: true } },
  });
  let exits = 0;
  const doc = Object.assign(new EventTarget(), {
    defaultView: window,
    exitPointerLock: () => exits++,
  });
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    getRootNode: () => root,
    requestPointerLock: request,
  });
  const bind = (owner: FullScreen) =>
    bindMouseLock(canvas as unknown as Parameters<typeof bindMouseLock>[0], owner);
  const unbind = bind(stage);
  const change = (owner: object | null) => {
    root.pointerLockElement = owner;
    doc.dispatchEvent(new Event("pointerlockchange"));
  };
  return { stage, root, window, canvas, doc, change, bind, unbind, exits: () => exits };
}

test("Escape clears Stage.mouseLock and a request renewed during exit is reacquired", async () => {
  let requests = 0;
  const b = binding(async () => {
    requests++;
  });
  b.stage.mouseLock = true;
  await Promise.resolve();
  b.change(b.canvas);
  b.stage.mouseLock = false;
  b.stage.mouseLock = true;
  assert.equal(b.exits(), 1);
  b.change(null);
  assert.equal(requests, 2);
  b.change(b.canvas);
  b.change(null);
  assert.equal(b.stage.mouseLock, false);
  b.change({});
  b.unbind();
  assert.equal(b.exits(), 1);
});

test("fullscreen can consume activation before the lock request: retry on a trusted canvas click", async () => {
  let attempts = 0;
  const b = binding(async () => {
    if (++attempts === 1) {
      throw new DOMException("No activation", "NotAllowedError");
    }
  });
  b.window.navigator.userActivation.isActive = false;
  b.stage.mouseLock = true;
  await Promise.resolve();
  assert.equal(b.stage.mouseLock, false);
  const click = Object.assign(new Event("pointerdown"), { button: 0 });
  b.canvas.dispatchEvent(click);
  assert.equal(attempts, 1);
  Object.defineProperty(click, "isTrusted", { value: true });
  b.window.navigator.userActivation.isActive = true;
  b.canvas.dispatchEvent(click);
  assert.equal(attempts, 2);
  assert.equal(b.stage.mouseLock, false);
  b.change(b.canvas);
  assert.equal(b.stage.mouseLock, true);
  b.window.dispatchEvent(new Event("blur"));
  assert.equal(b.stage.mouseLock, false);
  assert.equal(b.exits(), 1);
  b.unbind();
});

test("event-only pointer lock handles denial and releases a late grant after teardown", async () => {
  const b = binding(() => {});
  b.stage.mouseLock = true;
  b.doc.dispatchEvent(new Event("pointerlockerror"));
  await Promise.resolve();
  assert.equal(b.stage.mouseLock, false);
  b.stage.mouseLock = true;
  b.unbind();
  b.change(b.canvas);
  await Promise.resolve();
  assert.equal(b.exits(), 1);
});

test("a canvas bound before insertion releases its pointer lock on teardown", async () => {
  const b = binding(async () => {});
  const shadow = { pointerLockElement: null as object | null };
  b.canvas.getRootNode = () => shadow;
  b.stage.mouseLock = true;
  await Promise.resolve();
  shadow.pointerLockElement = b.canvas;
  b.doc.dispatchEvent(new Event("pointerlockchange"));
  assert.equal(b.stage.mouseLock, true);
  b.unbind();
  assert.equal(b.exits(), 1);
});

test("a late grant after unbinding respects the new player on the same canvas", async () => {
  let grant!: () => void;
  const b = binding(
    () =>
      new Promise<void>((resolve) => {
        grant = resolve;
      }),
  );
  b.stage.mouseLock = true;
  const grantFirst = grant;
  b.unbind();

  const next = new FullScreen({} as Scripting, null);
  const unbind = b.bind(next);
  next.mouseLock = true;
  b.change(b.canvas);
  grant();
  await Promise.resolve();
  grantFirst();
  await Promise.resolve();
  assert.equal(next.mouseLock, true);
  assert.equal(b.exits(), 0);
  unbind();
  assert.equal(b.exits(), 1);
});
