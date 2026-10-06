import assert from "node:assert/strict";
import { test } from "node:test";
import { BitmapStore } from "../../../packages/player/dist/bitmap.js";
import {
  BitmapObject,
  ButtonObject,
  Container,
  TextObject,
} from "../../../packages/player/dist/display.js";
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

test("a disabled field over a button lets the button take the hit, and its parent takes it where nothing does", () => {
  const stage = new Container();
  stage.object = { $display: stage } as never;
  const panel = new Container();
  panel.object = { $display: panel } as never;
  panel.loaderInfo = {} as never;
  stage.addChildAt(panel, 0);
  const button = new Container();
  button.object = { $display: button } as never;
  button.addChildAt(new BitmapObject(new BitmapStore(20, 20, true, 0xffffffff)), 0);
  panel.addChildAt(button, 0);
  // A label wider than the button, above it, which takes no pointer itself.
  const label = new TextObject(null);
  label.object = { $display: label, $mouseEnabled: false } as never;
  panel.addChildAt(label, 1);

  assert.equal(pointerTarget(stage, 10, 10, 100, 100), button);
  assert.equal(pointerTarget(stage, 50, 10, 100, 100), panel);
  panel.object.$mouseEnabled = false;
  assert.equal(pointerTarget(stage, 50, 10, 100, 100), stage);

  // Artwork above an interactive sibling does not hide it: interactive children are tried first.
  panel.object.$mouseEnabled = true;
  panel.addChildAt(new BitmapObject(new BitmapStore(20, 20, true, 0xffffffff)), 2);
  assert.equal(pointerTarget(stage, 10, 10, 100, 100), button);
});

test("a posted move waits for a flush or the next other input, and only the last counts", () => {
  const stage = new Container();
  const scripting = { stageWidth: 100, stageHeight: 100 } as unknown as Scripting;
  const input = new PointerInput(stage, scripting);
  input.post({ x: 1, y: 1 });
  input.post({ x: 2, y: 2 });
  assert.equal(input.handled, 0);
  input.flush();
  assert.equal(input.handled, 1);
  assert.equal(scripting.mouseStageX, 2);
  input.flush();
  assert.equal(input.handled, 1);

  input.post({ x: 3, y: 3 });
  input.handle("down", { x: 4, y: 4 });
  assert.equal(input.handled, 3);
  input.post({ x: 5, y: 5 });
  input.handle("move", { x: 6, y: 6 });
  input.flush();
  assert.equal(input.handled, 4);
  assert.equal(scripting.mouseStageX, 6);
});

test("sprite dragging follows the pointer in parent coordinates, clamps, and stops globally", () => {
  const stage = new Container();
  const parent = new Container();
  parent.setMatrix({ a: 2, b: 0, c: 0, d: 2, tx: 0, ty: 0 });
  stage.addChildAt(parent, 0);
  const first = new Container();
  first.setMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 5, ty: 6 });
  parent.addChildAt(first, 0);
  const second = new Container();
  parent.addChildAt(second, 1);
  const scripting = {
    stageWidth: 100,
    stageHeight: 100,
    mouseStageX: 10,
    mouseStageY: 20,
  } as unknown as Scripting;
  const input = new PointerInput(stage, scripting);

  input.startDrag(first, false, { xMin: 0, yMin: 0, xMax: 12, yMax: 14 });
  input.handle("move", { x: 30, y: 40 });
  assert.deepEqual([first.matrix.tx, first.matrix.ty], [12, 14]);

  input.startDrag(second, true, null);
  assert.deepEqual([second.matrix.tx, second.matrix.ty], [15, 20]);
  input.handle("move", { x: 40, y: 50 });
  assert.deepEqual([first.matrix.tx, first.matrix.ty], [12, 14]);
  assert.deepEqual([second.matrix.tx, second.matrix.ty], [20, 25]);

  input.stopDrag();
  input.handle("move", { x: 50, y: 60 });
  assert.deepEqual([second.matrix.tx, second.matrix.ty], [20, 25]);
});

test("the cursor is a hand under a sprite in buttonMode, as useHandCursor says, and an I-beam over selectable text", () => {
  const stage = new Container();
  stage.object = { $display: stage } as never;
  stage.loaderInfo = {} as never;
  const sprite = new Container();
  sprite.object = { $display: sprite, $buttonMode: true } as never;
  const art = new Container();
  art.object = { $display: art } as never;
  art.addChildAt(new BitmapObject(new BitmapStore(20, 20, true, 0xffffffff)), 0);
  sprite.addChildAt(art, 0);
  stage.addChildAt(sprite, 0);
  const field = new TextObject(null);
  field.object = { $display: field } as never;
  field.matrix.tx = 40;
  stage.addChildAt(field, 1);
  const scripting = {
    stageWidth: 100,
    stageHeight: 100,
    rt: { classNamed: () => ({}), construct: () => ({ $stopped: 0 }), call: () => {} },
  } as unknown as Scripting;
  const input = new PointerInput(stage, scripting);
  const shown: string[] = [];
  input.onCursor = (cursor) => shown.push(cursor);

  input.handle("move", { x: 10, y: 10 });
  input.handle("move", { x: 50, y: 10 });
  field.selectable = false;
  input.handle("move", { x: 51, y: 10 });
  assert.ok(sprite.object);
  sprite.object.$useHandCursor = false;
  input.handle("move", { x: 10, y: 10 });
  assert.deepEqual(shown, ["pointer", "text", "default"]);

  // The nearest sprite in buttonMode decides, and a disabled one shows none.
  sprite.object.$useHandCursor = true;
  art.object = { $display: art, $buttonMode: true, $useHandCursor: false } as never;
  input.handle("move", { x: 11, y: 10 });
  assert.equal(input.cursor(), "default");
  art.object = { $display: art } as never;
  sprite.object.$enabled = false;
  input.handle("move", { x: 12, y: 10 });
  assert.equal(input.cursor(), "default");
  sprite.object.$enabled = true;
  input.handle("move", { x: 13, y: 10 });
  assert.equal(input.cursor(), "pointer");

  // A button: a hand where it uses one, enabled or not.
  const button = new ButtonObject();
  button.object = { $display: button } as never;
  const area = new Container();
  area.addChildAt(new BitmapObject(new BitmapStore(20, 20, true, 0xffffffff)), 0);
  button.hitTestState = area;
  button.matrix.ty = 50;
  stage.addChildAt(button, 2);
  button.enabled = false;
  input.handle("move", { x: 10, y: 60 });
  assert.equal(input.cursor(), "pointer");
  button.useHandCursor = false;
  input.handle("move", { x: 11, y: 60 });
  assert.equal(input.cursor(), "default");
});

test("Mouse.hide and show change the host cursor without changing pointer targets", async () => {
  const { mouseNatives } = await import(
    "../../../packages/player/dist/playerglobal/flash/ui/Mouse.js"
  );
  const stage = new Container();
  stage.object = { $display: stage } as never;
  stage.loaderInfo = {} as never;
  const button = new ButtonObject();
  button.object = { $display: button } as never;
  const area = new Container();
  area.addChildAt(new BitmapObject(new BitmapStore(20, 20, true, 0xffffffff)), 0);
  button.hitTestState = area;
  stage.addChildAt(button, 0);
  const scripting = {
    stageWidth: 100,
    stageHeight: 100,
    mouseVisible: true,
    rt: { classNamed: () => ({}), construct: () => ({ $stopped: 0 }), call: () => {} },
  } as unknown as Scripting;
  const input = new PointerInput(stage, scripting);
  scripting.pointer = input;
  const shown: string[] = [];
  input.onCursor = (cursor) => shown.push(cursor);
  const natives = mouseNatives(scripting);
  const hide = natives["flash.ui::Mouse.hide"](scripting.rt) as () => void;
  const show = natives["flash.ui::Mouse.show"](scripting.rt) as () => void;

  input.handle("move", { x: 10, y: 10 });
  hide();
  input.handle("move", { x: 11, y: 10 });
  show();
  assert.equal(pointerTarget(stage, 11, 10, 100, 100), button);
  assert.deepEqual(shown, ["pointer", "none", "pointer"]);
});

test("a pointer event asks for a redraw only where it changes a button, focus or a selection", () => {
  const stage = new Container();
  stage.object = { $display: stage } as never;
  stage.loaderInfo = {} as never;
  const plain = new Container();
  plain.object = { $display: plain } as never;
  plain.addChildAt(new BitmapObject(new BitmapStore(20, 20, true, 0xffffffff)), 0);
  stage.addChildAt(plain, 0);
  const sprite = new Container();
  sprite.object = { $display: sprite, $buttonMode: true } as never;
  sprite.addChildAt(new BitmapObject(new BitmapStore(20, 20, true, 0xffffffff)), 0);
  sprite.matrix.tx = 40;
  stage.addChildAt(sprite, 1);
  const scripting = {
    stageWidth: 100,
    stageHeight: 100,
    rt: { classNamed: () => ({}), construct: () => ({ $stopped: 0 }), call: () => {} },
  } as unknown as Scripting;
  const input = new PointerInput(stage, scripting);

  // Moves over artwork, on and off a plain sprite, show at the next frame.
  for (const x of [5, 10, 30, 10]) {
    input.handle("move", { x, y: 5 });
  }

  assert.equal(input.redraws, 0);
  input.handle("move", { x: 45, y: 5 });
  input.handle("move", { x: 50, y: 5 });
  input.handle("move", { x: 70, y: 5 });
  assert.equal(input.redraws, 2);
  input.handle("down", { x: 70, y: 5 });
  input.handle("up", { x: 70, y: 5 });
  assert.equal(input.redraws, 4);
  assert.equal(input.handled, 9);
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

test("roll events reach only the objects entered or left when the pointer changes branches", () => {
  const stage = new Container();
  stage.object = { $display: stage } as never;
  const root = new Container();
  root.object = { $display: root } as never;
  root.loaderInfo = {} as never;
  stage.addChildAt(root, 0);
  const left = new Container();
  const right = new Container();
  for (const child of [left, right]) {
    child.object = { $display: child } as never;
    child.addChildAt(new BitmapObject(new BitmapStore(20, 20, true, 0xffffffff)), 0);
    root.addChildAt(child, root.children.length);
  }

  right.matrix.tx = 40;
  const heard: string[] = [];
  const listen = (d: Container, label: string) => {
    const object = d.object;
    assert.ok(object);
    object.$listeners = new Map(
      ["rollOver", "rollOut"].map((type) => [
        type,
        [
          {
            fn: {
              $f: (_self: unknown, event: { $bubbles: boolean; $related: unknown }) => {
                assert.equal(event.$bubbles, false);
                const related =
                  event.$related === left.object
                    ? "left"
                    : event.$related === right.object
                      ? "right"
                      : "none";
                heard.push(`${label}:${type}:${related}`);
              },
            },
            capture: false,
            priority: 0,
          },
        ],
      ]),
    );
  };
  listen(root, "root");
  listen(left, "left");
  listen(right, "right");
  const scripting = {
    stageWidth: 100,
    stageHeight: 100,
    rt: {
      classNamed: () => ({}),
      construct: (
        _cls: unknown,
        type: string,
        bubbles: boolean,
        _cancelable: boolean,
        _x: number,
        _y: number,
        related: unknown,
      ) => ({ $type: type, $bubbles: bubbles, $related: related, $stopped: 0 }),
      call: (fn: { $f: (self: unknown, event: unknown) => void }, self: unknown, event: unknown) =>
        fn.$f(self, event),
    },
  } as unknown as Scripting;
  const input = new PointerInput(stage, scripting);

  assert.equal(pointerTarget(stage, 10, 10, 100, 100), left);
  input.handle("move", { x: 10, y: 10 });
  assert.deepEqual(heard.splice(0), ["left:rollOver:none", "root:rollOver:none"]);
  input.handle("move", { x: 45, y: 10 });
  assert.deepEqual(heard.splice(0), ["left:rollOut:right", "right:rollOver:left"]);
  input.handle("leave", { x: 120, y: 10 });
  assert.deepEqual(heard, ["right:rollOut:none", "root:rollOut:none"]);
});

test("a list under a timeline's mask layer takes no click where the mask hides it", () => {
  // Flash picks through mask layers as it draws them (the corpus's
  // `mouse_pick_masking`): a scrolled list's rows below the mask are hidden
  // and take no clicks, so what is under the pointer there is the stage.
  const stage = new Container();
  stage.object = { $display: stage } as never;
  stage.loaderInfo = {} as never;
  const list = new Container();
  list.object = { $display: list } as never;
  stage.addChildAt(list, 0);
  const mask = new BitmapObject(new BitmapStore(100, 50, true, 0xffffffff));
  mask.clipDepth = 5;
  list.placeAtDepth(mask, 1);
  const row = new Container();
  row.object = { $display: row } as never;
  row.addChildAt(new BitmapObject(new BitmapStore(100, 100, true, 0xffffffff)), 0);
  list.placeAtDepth(row, 2);

  assert.equal(pointerTarget(stage, 10, 10, 200, 200), row);
  assert.equal(pointerTarget(stage, 10, 70, 200, 200), stage);

  // One placed past the mask's depth is not under it.
  const below = new Container();
  below.object = { $display: below } as never;
  below.addChildAt(new BitmapObject(new BitmapStore(100, 100, true, 0xffffffff)), 0);
  list.placeAtDepth(below, 6);
  assert.equal(pointerTarget(stage, 10, 70, 200, 200), below);
});
