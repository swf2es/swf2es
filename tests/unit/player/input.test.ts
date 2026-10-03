import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../packages/player/dist/bitmap.js";
import { BitmapObject, Container, TextObject } from "../../../packages/player/dist/display.js";
import { PointerInput, pointerTarget } from "../../../packages/player/dist/input.js";
import type { Scripting } from "../../../packages/player/dist/scripting.js";

test("the topmost artwork targets its interactive parent, with mouseChildren and visibility respected", () => {
  const stage = new Container();
  stage.object = { $display: stage } as never;
  const root = new Container();
  root.object = { $display: root } as never;
  root.loaderInfo = {} as never;
  stage.addChildAt(root, 0);
  const back = new Container();
  const front = new Container();
  back.object = {} as never;
  front.object = {} as never;
  for (const d of [back, front]) {
    d.addChildAt(new BitmapObject(new BitmapStore(20, 20, true, 0xffffffff)), 0);
    root.addChildAt(d, root.children.length);
  }

  assert.equal(pointerTarget(stage, 10, 10, 100, 100), front);
  front.visible = false;
  assert.equal(pointerTarget(stage, 10, 10, 100, 100), back);
  back.visible = false;
  assert.equal(pointerTarget(stage, 10, 10, 100, 100), stage);
  back.visible = true;
  front.visible = true;
  assert.ok(root.object);
  root.object.$mouseChildren = false;
  assert.equal(pointerTarget(stage, 10, 10, 100, 100), root);
  assert.equal(pointerTarget(stage, 50, 50, 100, 100), stage);
  assert.equal(pointerTarget(stage, -1, 10, 100, 100), null);

  const field = new TextObject(null);
  field.object = { $display: field } as never;
  field.matrix.tx = 40;
  root.addChildAt(field, root.children.length);
  root.object.$mouseChildren = true;
  assert.equal(pointerTarget(stage, 50, 10, 100, 100), field);
});

test("a disabled overlay lets pointer input reach an interactive object below it", () => {
  const stage = new Container();
  stage.object = { $display: stage } as never;
  stage.loaderInfo = {} as never;
  const button = new Container();
  button.object = { $display: button } as never;
  button.addChildAt(new BitmapObject(new BitmapStore(20, 20, true, 0xffffffff)), 0);
  stage.addChildAt(button, 0);

  const overlay = new Container();
  overlay.object = {
    $display: overlay,
    $mouseEnabled: false,
    $mouseChildren: false,
  } as never;
  overlay.addChildAt(new BitmapObject(new BitmapStore(20, 20, true, 0xffffffff)), 0);
  stage.addChildAt(overlay, 1);

  assert.equal(pointerTarget(stage, 10, 10, 100, 100), button);

  // A visible shape without an interactive object still blocks what is underneath.
  overlay.object.$mouseEnabled = true;
  assert.equal(pointerTarget(stage, 10, 10, 100, 100), overlay);
});

test("a pointer down dispatches capture, target and bubble with target-local coordinates", () => {
  const stage = new Container();
  stage.object = { $display: stage } as never;
  const root = new Container();
  root.object = { $display: root } as never;
  root.loaderInfo = {} as never;
  stage.addChildAt(root, 0);
  const child = new Container();
  child.object = { $display: child } as never;
  child.matrix.tx = 10;
  child.addChildAt(new BitmapObject(new BitmapStore(20, 20, true, 0xffffffff)), 0);
  root.addChildAt(child, 0);
  const heard: string[] = [];
  const listen = (d: Container, capture: boolean, label: string) => {
    const object = d.object;
    assert.ok(object);
    object.$listeners ??= new Map();
    const list = object.$listeners.get("mouseDown") ?? [];
    list.push({
      fn: {
        $f: (_this: unknown, event: { $mouseX: number; $target: unknown }) => {
          assert.equal(event.$mouseX, 5);
          assert.equal(event.$target, child.object);
          heard.push(label);
        },
      },
      capture,
      priority: 0,
    });
    object.$listeners.set("mouseDown", list);
  };
  listen(root, true, "capture");
  listen(child, false, "target");
  listen(root, false, "bubble");
  const scripting = {
    stageWidth: 100,
    stageHeight: 100,
    mouseStageX: 0,
    mouseStageY: 0,
    rt: {
      classNamed: () => ({}),
      construct: (
        _cls: unknown,
        type: string,
        bubbles: boolean,
        _cancelable: boolean,
        x: number,
        y: number,
      ) => ({
        $type: type,
        $bubbles: bubbles,
        $mouseX: x,
        $mouseY: y,
        $stopped: 0,
      }),
      call: (fn: { $f: (self: unknown, event: unknown) => void }, self: unknown, event: unknown) =>
        fn.$f(self, event),
    },
  } as unknown as Scripting;

  const input = new PointerInput(stage, scripting);
  input.handle("down", { x: 15, y: 5, button: 0, buttons: 1 });
  assert.deepEqual(heard, ["capture", "target", "bubble"]);
  assert.equal(scripting.mouseStageX, 15);

  assert.ok(child.object);
  child.object.$listeners.set("click", [
    { fn: { $f: () => heard.push("click") }, capture: false, priority: 0 },
  ]);
  input.handle("leave", { x: 120, y: 5, button: 0, buttons: 1 });
  input.handle("up", { x: 120, y: 5, button: 0, buttons: 0 });
  assert.deepEqual(heard, ["capture", "target", "bubble"]);
  // Each event counts as a change a host draws for.
  assert.equal(input.handled, 3);
});
