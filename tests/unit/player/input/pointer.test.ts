import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { BitmapStore } from "../../../../packages/player/dist/bitmap/bitmap.js";
import {
  BitmapObject,
  ButtonObject,
  Container,
  TextObject,
} from "../../../../packages/player/dist/display/display.js";
import {
  dropTargetOf,
  PointerInput,
  pointerTarget,
  setHitArea,
} from "../../../../packages/player/dist/input/pointer.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Clipboard } from "../../../../packages/player/dist/scripting/clipboard.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compileScripts } from "../../../player/scripts.ts";

test("the topmost artwork targets its interactive parent, with mouseChildren and visibility respected", () => {
  const stage = new Container();
  stage.object = { $display: stage } as never;
  stage.loaderInfo = {} as never;
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
  assert.equal(pointerTarget(stage, 50, 50, 100, 100), stage);
  // A sprite takes its children's hits itself; the main root is never the
  // target, as Flash Player 32 has it, and the stage takes them.
  assert.equal(pointerTarget(stage, 10, 10, 100, 100), stage);
  const info = root.loaderInfo;
  root.loaderInfo = null;
  assert.equal(pointerTarget(stage, 10, 10, 100, 100), root);
  root.loaderInfo = info;
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
  stage.loaderInfo = {} as never;
  // A sprite on the stage, not the main root, which would leave the hits it takes to the stage.
  const panel = new Container();
  panel.object = { $display: panel } as never;
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
  const scripting = {
    stageWidth: 100,
    stageHeight: 100,
    clipboard: new Clipboard(null),
  } as unknown as Scripting;
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
    clipboard: new Clipboard(null),
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

/** A white square of `size` at (x, y), which takes no pointer itself. */
function square(x: number, y: number, size = 20): BitmapObject {
  const b = new BitmapObject(new BitmapStore(size, size, true, 0xffffffff));
  b.object = { $display: b } as never;
  b.setMatrix({ a: 1, b: 0, c: 0, d: 1, tx: x, ty: y });
  return b;
}

/** A stage with a root under it, as a SWF's, and a sprite on the root drawing a square at (0, 0). */
function stageWithSprite(): { stage: Container; root: Container; sprite: Container } {
  const stage = new Container();
  stage.object = { $display: stage } as never;
  const root = new Container();
  root.object = { $display: root } as never;
  root.loaderInfo = {} as never;
  stage.addChildAt(root, 0);
  const sprite = new Container();
  sprite.object = { $display: sprite } as never;
  sprite.addChildAt(square(0, 0), 0);
  root.addChildAt(sprite, 0);
  return { stage, root, sprite };
}

test("a sprite with a hitArea is hit where the area draws, visible or not, and only there", () => {
  const { stage, root, sprite } = stageWithSprite();
  const area = new Container();
  area.object = { $display: area } as never;
  area.addChildAt(square(50, 50), 0);
  area.visible = false;
  root.addChildAt(area, 1);
  assert.equal(pointerTarget(stage, 10, 10, 100, 100), sprite);

  setHitArea(sprite, area);
  assert.equal(pointerTarget(stage, 10, 10, 100, 100), stage);
  assert.equal(pointerTarget(stage, 60, 60, 100, 100), sprite);

  // Shown and enabled, the area on top takes the pointer itself, as Flash's documentation warns.
  area.visible = true;
  assert.equal(pointerTarget(stage, 60, 60, 100, 100), area);
  assert.ok(area.object);
  area.object.$mouseEnabled = false;
  assert.equal(pointerTarget(stage, 60, 60, 100, 100), sprite);

  // Its interactive children still pick for themselves, but not with mouseChildren false.
  const child = new Container();
  child.object = { $display: child } as never;
  child.addChildAt(square(0, 80), 0);
  sprite.addChildAt(child, 1);
  assert.equal(pointerTarget(stage, 10, 90, 100, 100), child);
  assert.ok(sprite.object);
  sprite.object.$mouseChildren = false;
  assert.equal(pointerTarget(stage, 10, 90, 100, 100), stage);
  assert.equal(pointerTarget(stage, 60, 60, 100, 100), sprite);
  sprite.object.$mouseChildren = true;

  // An area inside the sprite moves with it; one off the display list hits nothing.
  root.removeChild(area);
  sprite.addChildAt(area, 0);
  sprite.setMatrix({ a: 1, b: 0, c: 0, d: 1, tx: 10, ty: 0 });
  assert.equal(pointerTarget(stage, 65, 60, 100, 100), sprite);
  sprite.removeChild(area);
  assert.equal(pointerTarget(stage, 65, 60, 100, 100), stage);

  // Without it, the sprite is hit by its own drawing again.
  sprite.addChildAt(area, 0);
  setHitArea(sprite, null);
  assert.equal(pointerTarget(stage, 15, 10, 100, 100), sprite);
  assert.equal(pointerTarget(stage, 75, 90, 100, 100), stage);
});

test("a sprite in buttonMode with a hitArea shows its hand over the area", () => {
  const { stage, root, sprite } = stageWithSprite();
  const area = new Container();
  area.object = { $display: area, $mouseEnabled: false } as never;
  area.addChildAt(square(50, 50), 0);
  root.addChildAt(area, 1);
  assert.ok(sprite.object);
  sprite.object.$buttonMode = true;
  setHitArea(sprite, area);
  const scripting = {
    stageWidth: 100,
    stageHeight: 100,
    mouseCursor: "auto",
    rt: { classNamed: () => ({}), construct: () => ({ $stopped: 0 }), call: () => {} },
    clipboard: new Clipboard(null),
  } as unknown as Scripting;
  const input = new PointerInput(stage, scripting);
  input.handle("move", { x: 10, y: 10 });
  assert.equal(input.cursor(), "default");
  input.handle("move", { x: 60, y: 60 });
  assert.equal(input.cursor(), "pointer");
});

test("dropTarget is the topmost object drawn under the pointer as a drag moves and ends, outside the dragged sprite", () => {
  const { stage, root, sprite } = stageWithSprite();
  const target = new Container();
  target.object = { $display: target } as never;
  const shape = square(40, 0);
  target.addChildAt(shape, 0);
  root.addChildAt(target, 0);
  const scripting = {
    stageWidth: 100,
    stageHeight: 100,
    mouseStageX: 10,
    mouseStageY: 10,
    rt: { classNamed: () => ({}), construct: () => ({ $stopped: 0 }), call: () => {} },
    clipboard: new Clipboard(null),
  } as unknown as Scripting;
  const input = new PointerInput(stage, scripting);

  assert.equal(dropTargetOf(sprite), null);
  input.startDrag(sprite, false, null);
  assert.equal(dropTargetOf(sprite), null);
  input.handle("move", { x: 50, y: 10 });
  assert.equal(dropTargetOf(sprite), shape);
  input.handle("move", { x: 90, y: 90 });
  input.stopDrag();
  assert.equal(dropTargetOf(sprite), null);

  input.startDrag(sprite, false, null);
  input.handle("move", { x: 45, y: 5 });
  input.stopDrag();
  assert.equal(dropTargetOf(sprite), shape);
  input.handle("move", { x: 90, y: 90 });
  assert.equal(dropTargetOf(sprite), shape);
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
    clipboard: new Clipboard(null),
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
    "../../../../packages/player/dist/playerglobal/flash/ui/Mouse.js"
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
    clipboard: new Clipboard(null),
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
    clipboard: new Clipboard(null),
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
    clipboard: new Clipboard(null),
  } as unknown as Scripting;

  const input = new PointerInput(stage, scripting);
  input.handle("down", { x: 15, y: 5, button: 0, buttons: 1 });
  assert.deepEqual(heard, ["capture", "target", "bubble"]);
  assert.equal(scripting.mouseStageX, 15);

  assert.ok(child.object);
  child.object.$listeners.set("click", [
    { fn: { $f: () => heard.push("click") }, capture: false, priority: 0 },
  ]);
  // A leave while the button is down is held back, as Flash keeps the mouse
  // until the release; the release outside is no click, and the leave after it counts.
  input.handle("leave", { x: 120, y: 5, button: 0, buttons: 1 });
  assert.equal(input.handled, 1);
  input.handle("up", { x: 120, y: 5, button: 0, buttons: 0 });
  input.handle("leave", { x: 120, y: 5, button: 0, buttons: 0 });
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
    clipboard: new Clipboard(null),
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

// Its own: node runs test files at once, and a compile writes its job list into `out`.
const out = fileURLToPath(new URL("../../out/player-pointer/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

// Boxes "a" holding "a1", "b" beside them and a SimpleButton "btn": the
// stage traces the mouse events it hears, and each object its roll events.
const ORDER_SOURCE = `package {
  import flash.display.Shape;
  import flash.display.SimpleButton;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.MouseEvent;

  public class MouseOrder extends Sprite {
    private function box(name:String, x:Number, y:Number, size:Number):Sprite {
      var s:Sprite = new Sprite();
      s.name = name;
      s.graphics.beginFill(0xff0000);
      s.graphics.drawRect(0, 0, size, size);
      s.x = x;
      s.y = y;
      return s;
    }

    private function nameOf(o:Object):String {
      return o == null ? "null" : o == stage ? "stage" : o == this ? "root" : o.name;
    }

    private function heard(e:Event):void {
      var line:String = e.type + " " + nameOf(e.target);
      if (e is MouseEvent) {
        var m:MouseEvent = MouseEvent(e);
        line += " " + nameOf(m.relatedObject) + " " + m.buttonDown + " " + m.localX + "," + m.localY;
      }

      trace(line + " @" + stage.mouseX + "," + stage.mouseY);
    }

    public function MouseOrder() {
      var a:Sprite = box("a", 0, 0, 80);
      a.addChild(box("a1", 20, 20, 40));
      addChild(a);
      addChild(box("b", 100, 0, 80));
      var hit:Shape = new Shape();
      hit.graphics.beginFill(0);
      hit.graphics.drawRect(0, 0, 80, 80);
      var btn:SimpleButton = new SimpleButton(hit, hit, hit, hit);
      btn.name = "btn";
      btn.x = 200;
      addChild(btn);
      for each (var type:String in ["mouseDown", "mouseUp", "click", "mouseMove", "mouseOver", "mouseOut"]) {
        stage.addEventListener(type, heard);
      }

      for each (var o:Object in [stage, this, a, a.getChildAt(0), getChildAt(1), btn]) {
        o.addEventListener("rollOver", heard);
        o.addEventListener("rollOut", heard);
      }

      stage.addEventListener("mouseLeave", heard);
    }
  }
}`;

test("the pointer's events come in Flash Player 32's order, to its targets", { skip }, async () => {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const abc = compileScripts([{ name: "MouseOrder", source: ORDER_SOURCE }], out).get(
    "MouseOrder",
  ) as Uint8Array;
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(abc, 1, "MouseOrder", 300, 200), scripting);
  await player.start();
  const pointer = player.pointer;
  assert.ok(pointer);
  let buttons = 0;
  const input = (
    type: "move" | "down" | "up" | "leave",
    x: number,
    y: number,
    button = 0,
  ): string[] => {
    buttons = type === "down" ? buttons | (1 << button) : type === "up" ? 0 : buttons;
    pointer.handle(type, { x, y, button, buttons });
    return lines.splice(0);
  };

  // Each of these is what Flash Player 32 traced for the same input (in
  // Electron's PepperFlash, driven over the DevTools protocol): a move sends
  // mouseMove first, then the hover's out, roll outs, roll overs and over.
  // The empty stage takes the move but no hover, so it has no over or out.
  assert.deepEqual(input("move", 150, 150), ["mouseMove stage null false 150,150 @150,150"]);
  assert.deepEqual(input("move", 10, 10), [
    "mouseMove a null false 10,10 @10,10",
    "rollOver a null false 10,10 @10,10",
    "rollOver root null false 10,10 @10,10",
    "mouseOver a null false 10,10 @10,10",
  ]);
  // Into a child, and out of it to a sibling of its parent.
  assert.deepEqual(input("move", 30, 30), [
    "mouseMove a1 null false 10,10 @30,30",
    "mouseOut a a1 false 30,30 @30,30",
    "rollOver a1 a false 10,10 @30,30",
    "mouseOver a1 a false 10,10 @30,30",
  ]);
  assert.deepEqual(input("move", 110, 10), [
    "mouseMove b null false 10,10 @110,10",
    "mouseOut a1 b false 90,-10 @110,10",
    "rollOut a1 b false 90,-10 @110,10",
    "rollOut a b false 110,10 @110,10",
    "rollOver b a1 false 10,10 @110,10",
    "mouseOver b a1 false 10,10 @110,10",
  ]);
  // Out to the stage, then onto a SimpleButton.
  assert.deepEqual(input("move", 150, 150), [
    "mouseMove stage null false 150,150 @150,150",
    "mouseOut b null false 50,150 @150,150",
    "rollOut b null false 50,150 @150,150",
    "rollOut root null false 150,150 @150,150",
  ]);
  assert.deepEqual(input("move", 210, 10), [
    "mouseMove btn null false 10,10 @210,10",
    "rollOver btn null false 10,10 @210,10",
    "rollOver root null false 210,10 @210,10",
    "mouseOver btn null false 10,10 @210,10",
  ]);
  // A move to where the mouse already is sends nothing.
  assert.deepEqual(input("move", 210, 10), []);

  // A press at a new point is a move there, with the button still up, then
  // the press; its release where it was is the release's own events.
  assert.deepEqual(input("down", 110, 10), [
    "mouseMove b null false 10,10 @110,10",
    "mouseOut btn b false -90,10 @110,10",
    "rollOut btn b false -90,10 @110,10",
    "rollOver b btn false 10,10 @110,10",
    "mouseOver b btn false 10,10 @110,10",
    "mouseDown b null true 10,10 @110,10",
  ]);
  assert.deepEqual(input("up", 110, 10), [
    "mouseUp b null false 10,10 @110,10",
    "click b null false 10,10 @110,10",
  ]);

  // A release at a new point is a move there with the button down, then the release.
  input("move", 10, 10);
  input("down", 10, 10);
  assert.deepEqual(input("up", 110, 10), [
    "mouseMove b null true 10,10 @110,10",
    "mouseOut a b true 110,10 @110,10",
    "rollOut a b true 110,10 @110,10",
    "rollOver b a true 10,10 @110,10",
    "mouseOver b a true 10,10 @110,10",
    "mouseUp b null false 10,10 @110,10",
  ]);

  // Dragged off the player, the mouse stays the player's: no leave, and
  // the moves outside go to the stage, as does the release, a host's leave
  // after it the mouse's leave then.
  input("move", 30, 30);
  input("down", 30, 30);
  assert.deepEqual(input("leave", 400, 100), []);
  assert.deepEqual(input("move", 400, 100), [
    "mouseMove stage null true 400,100 @400,100",
    "mouseOut a1 null true 380,80 @400,100",
    "rollOut a1 null true 380,80 @400,100",
    "rollOut a null true 400,100 @400,100",
    "rollOut root null true 400,100 @400,100",
  ]);
  assert.deepEqual(input("up", 400, 100), ["mouseUp stage null false 400,100 @400,100"]);
  assert.deepEqual(input("leave", 400, 100), ["mouseLeave stage @400,100"]);

  // Left with the button up: out of what it was over, at the stage point
  // (-1, -1), though the mouse stays where it was, then the stage's leave.
  input("move", 30, 30);
  assert.deepEqual(input("leave", 400, 100), [
    "mouseOut a1 null false -21,-21 @30,30",
    "rollOut a1 null false -21,-21 @30,30",
    "rollOut a null false -1,-1 @30,30",
    "rollOut root null false -1,-1 @30,30",
    "mouseLeave stage @30,30",
  ]);
  // Back where it left, the mouse has not moved: nothing, until it does.
  assert.deepEqual(input("move", 30, 30), []);
  assert.deepEqual(input("move", 31, 31), [
    "mouseMove a1 null false 11,11 @31,31",
    "rollOver a1 null false 11,11 @31,31",
    "rollOver a null false 31,31 @31,31",
    "rollOver root null false 31,31 @31,31",
    "mouseOver a1 null false 11,11 @31,31",
  ]);

  // A leave told twice, as a right button's release outside follows its leave, is one.
  assert.deepEqual(input("down", 31, 31, 2), []);
  assert.deepEqual(input("leave", 400, 100), [
    "mouseOut a1 null false -21,-21 @31,31",
    "rollOut a1 null false -21,-21 @31,31",
    "rollOut a null false -1,-1 @31,31",
    "rollOut root null false -1,-1 @31,31",
    "mouseLeave stage @31,31",
  ]);
  assert.deepEqual(input("up", 400, 100, 2), []);
  assert.deepEqual(input("leave", 400, 100), []);

  // The left button let go while the right stays down, which Chrome tells as
  // a move, is the release: the leave after it is not held back.
  input("move", 110, 10);
  input("down", 110, 10);
  input("down", 110, 10, 2);
  buttons = 2;
  assert.deepEqual(input("move", 110, 10), [
    "mouseUp b null false 10,10 @110,10",
    "click b null false 10,10 @110,10",
  ]);
  assert.deepEqual(input("leave", 400, 100), [
    "mouseOut b null false -101,-1 @110,10",
    "rollOut b null false -101,-1 @110,10",
    "rollOut root null false -1,-1 @110,10",
    "mouseLeave stage @110,10",
  ]);

  // A release lost outside the browser shows on the next move as one, there,
  // and the leave after it.
  buttons = 0;
  input("move", 110, 10);
  input("down", 110, 10);
  input("move", 400, 100);
  buttons = 0;
  assert.deepEqual(input("move", 500, 100), [
    "mouseMove stage null true 500,100 @500,100",
    "mouseUp stage null false 500,100 @500,100",
    "mouseLeave stage @500,100",
  ]);
});

const GAPS_SOURCE = `package {
  import flash.display.DisplayObject;
  import flash.display.Shape;
  import flash.display.SimpleButton;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.MouseEvent;

  // Boxes "a" holding "a1", "b", "c" holding "c1" holding "c2", and a
  // SimpleButton "btn": the stage traces the mouse events it hears, each
  // object its roll events; cmd changes them between frames. In Flash, the
  // probe also logged each line, and took cmd, through ExternalInterface.
  public class MouseGaps extends Sprite {
    private var named:Object = {};

    private function box(name:String, x:Number, y:Number, size:Number):Sprite {
      var s:Sprite = new Sprite();
      s.name = name;
      var art:Shape = new Shape();
      art.graphics.beginFill(0xff0000);
      art.graphics.drawRect(0, 0, size, size);
      s.addChild(art);
      s.x = x;
      s.y = y;
      named[name] = s;
      return s;
    }

    // Flash's float noise left out: 50.000003814697266 is 50.
    private function round(n:Number):Number {
      return Math.round(n * 1000) / 1000;
    }

    private function nameOf(o:Object):String {
      return o == null ? "null" : o == stage ? "stage" : o == this ? "root" : o.name;
    }

    private function heard(e:Event):void {
      var line:String = e.type + " " + nameOf(e.target);
      if (e is MouseEvent) {
        var m:MouseEvent = MouseEvent(e);
        line += " " + nameOf(m.relatedObject) + " " + m.buttonDown + " " + round(m.localX) + "," + round(m.localY);
        if (e.type == "mouseWheel") {
          line += " " + m.delta;
        }
      }

      trace(line + " @" + stage.mouseX + "," + stage.mouseY);
    }

    private function state(color:uint):Shape {
      var s:Shape = new Shape();
      s.graphics.beginFill(color);
      s.graphics.drawRect(0, 0, 80, 80);
      return s;
    }

    public function cmd(op:String, name:String, key:String, value:*):void {
      var o:Object = name == "root" ? this : named[name];
      switch (op) {
        case "set":
          o[key] = value;
          break;
        case "remove":
          o.parent.removeChild(DisplayObject(o));
          break;
        case "add":
          (key == "stage" ? stage : key ? named[key] : this).addChild(DisplayObject(o));
          break;
        case "draw":
          var r:Array = String(value).split(",");
          o.graphics.beginFill(0x808080);
          o.graphics.drawRect(r[0], r[1], r[2], r[3]);
          break;
      }
    }

    public function MouseGaps() {
      var a:Sprite = box("a", 0, 0, 80);
      a.addChild(box("a1", 20, 20, 40));
      addChild(a);
      addChild(box("b", 100, 0, 80));
      var c:Sprite = box("c", 0, 100, 90);
      var c1:Sprite = box("c1", 20, 20, 50);
      c1.addChild(box("c2", 20, 20, 20));
      c.addChild(c1);
      addChild(c);
      var btn:SimpleButton = new SimpleButton(state(0xff0000), state(0x00ff00), state(0x0000ff), state(0));
      btn.name = "btn";
      btn.x = 200;
      named.btn = btn;
      addChild(btn);
      for each (var type:String in ["mouseDown", "mouseUp", "click", "doubleClick", "mouseMove", "mouseOver", "mouseOut", "mouseWheel"]) {
        stage.addEventListener(type, heard);
      }

      for each (var o:Object in [stage, this, a, named.a1, named.b, c, c1, named.c2, btn]) {
        o.addEventListener("rollOver", heard);
        o.addEventListener("rollOut", heard);
      }

      stage.addEventListener("mouseLeave", heard);
    }
  }
}`;

/**
 * MouseGaps playing, and the input a test gives it: each call returns the
 * lines traced since the last. Moves, presses and releases are 300 ms apart
 * unless a call says otherwise, too far apart for a double click.
 */
async function gaps() {
  const wasm = await WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const abc = compileScripts([{ name: "MouseGaps", source: GAPS_SOURCE }], out).get(
    "MouseGaps",
  ) as Uint8Array;
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(abc, 1, "MouseGaps", 400, 300), scripting);
  await player.start();
  lines.length = 0;
  const pointer = player.pointer;
  assert.ok(pointer);
  let buttons = 0;
  let time = 0;
  const input = (type: "move" | "down" | "up", x: number, y: number, wait = 300): string[] => {
    buttons = type === "down" ? 1 : type === "up" ? 0 : buttons;
    time += wait;
    pointer.handle(type, { x, y, button: 0, buttons, time });
    return lines.splice(0);
  };
  const cmd = (op: string, name: string, key: string | null = null, value: unknown = null) => {
    const rt = scripting.rt;
    rt.callProperty(player.root.object, rt.publicName("cmd"), op, name, key, value as never);
    return lines.splice(0);
  };
  const frame = (): string[] => {
    player.tick();
    return lines.splice(0);
  };

  return { input, cmd, frame, player, pointer, scripting };
}

test("what the main root would take goes to the stage, and a disabled object's hit to its nearest enabled ancestor", {
  skip,
}, async () => {
  const { input, cmd } = await gaps();

  // Each of these is what Flash Player 32 traced (PepperFlash, over the
  // DevTools protocol). A sprite whose mouseEnabled is false, under the
  // root, leaves its art's hits to the stage, not to the root.
  cmd("set", "a", "mouseEnabled", false);
  assert.deepEqual(input("move", 10, 10), ["mouseMove stage null false 10,10 @10,10"]);
  assert.deepEqual(input("move", 30, 30), [
    "mouseMove a1 null false 10,10 @30,30",
    "rollOver a1 null false 10,10 @30,30",
    "rollOver a null false 30,30 @30,30",
    "rollOver root null false 30,30 @30,30",
    "mouseOver a1 null false 10,10 @30,30",
  ]);
  assert.deepEqual(input("move", 10, 10), [
    "mouseMove stage null false 10,10 @10,10",
    "mouseOut a1 null false -10,-10 @10,10",
    "rollOut a1 null false -10,-10 @10,10",
    "rollOut a null false 10,10 @10,10",
    "rollOut root null false 10,10 @10,10",
  ]);
  assert.deepEqual(input("down", 10, 10), ["mouseDown stage null true 10,10 @10,10"]);
  assert.deepEqual(input("up", 10, 10), [
    "mouseUp stage null false 10,10 @10,10",
    "click stage null false 10,10 @10,10",
  ]);
  input("move", 150, 150);
  cmd("set", "a", "mouseEnabled", true);

  // Deeper, the hit goes up to the nearest ancestor that takes the pointer,
  // past one or two that do not, and to the stage where that is the root.
  cmd("set", "c1", "mouseEnabled", false);
  assert.deepEqual(input("move", 30, 130), [
    "mouseMove c null false 30,30 @30,130",
    "rollOver c null false 30,30 @30,130",
    "rollOver root null false 30,130 @30,130",
    "mouseOver c null false 30,30 @30,130",
  ]);
  assert.deepEqual(input("move", 50, 150), [
    "mouseMove c2 null false 10,10 @50,150",
    "mouseOut c c2 false 50,50 @50,150",
    "rollOver c2 c false 10,10 @50,150",
    "rollOver c1 c false 30,30 @50,150",
    "mouseOver c2 c false 10,10 @50,150",
  ]);
  input("move", 150, 150);
  cmd("set", "c2", "mouseEnabled", false);
  assert.deepEqual(input("move", 50, 150), [
    "mouseMove c null false 50,50 @50,150",
    "rollOver c null false 50,50 @50,150",
    "rollOver root null false 50,150 @50,150",
    "mouseOver c null false 50,50 @50,150",
  ]);
  input("move", 150, 150);
  cmd("set", "c", "mouseEnabled", false);
  assert.deepEqual(input("move", 50, 150), ["mouseMove stage null false 50,150 @50,150"]);
  assert.deepEqual(input("move", 10, 110), ["mouseMove stage null false 10,110 @10,110"]);
  input("move", 150, 150);
  for (const name of ["c", "c1", "c2"]) {
    cmd("set", name, "mouseEnabled", true);
  }

  // A sprite whose mouseChildren is false takes its children's hits.
  cmd("set", "c1", "mouseChildren", false);
  assert.deepEqual(input("move", 50, 150), [
    "mouseMove c1 null false 30,30 @50,150",
    "rollOver c1 null false 30,30 @50,150",
    "rollOver c null false 50,50 @50,150",
    "rollOver root null false 50,150 @50,150",
    "mouseOver c1 null false 30,30 @50,150",
  ]);
  input("move", 150, 150);
  cmd("set", "c1", "mouseChildren", true);

  // The root's own art, and all of it with its mouseChildren false, are the stage's.
  cmd("draw", "root", null, "300,200,80,80");
  assert.deepEqual(input("move", 310, 210), ["mouseMove stage null false 310,210 @310,210"]);
  assert.deepEqual(input("down", 310, 210), ["mouseDown stage null true 310,210 @310,210"]);
  assert.deepEqual(input("up", 310, 210), [
    "mouseUp stage null false 310,210 @310,210",
    "click stage null false 310,210 @310,210",
  ]);
  cmd("set", "root", "mouseChildren", false);
  assert.deepEqual(input("move", 30, 30), ["mouseMove stage null false 30,30 @30,30"]);
  input("move", 150, 150);
  cmd("set", "root", "mouseChildren", true);

  // The root's mouseEnabled false leaves its children theirs.
  cmd("set", "root", "mouseEnabled", false);
  assert.deepEqual(input("move", 30, 30), [
    "mouseMove a1 null false 10,10 @30,30",
    "rollOver a1 null false 10,10 @30,30",
    "rollOver a null false 30,30 @30,30",
    "rollOver root null false 30,30 @30,30",
    "mouseOver a1 null false 10,10 @30,30",
  ]);
  input("move", 150, 150);
  cmd("set", "root", "mouseEnabled", true);

  // A sprite on the stage itself, beside the root, takes its hits as any other.
  cmd("add", "b", "stage");
  cmd("set", "b", "mouseChildren", false);
  assert.deepEqual(input("move", 110, 10), [
    "mouseMove b null false 10,10 @110,10",
    "rollOver b null false 10,10 @110,10",
    "mouseOver b null false 10,10 @110,10",
  ]);
  assert.deepEqual(input("move", 150, 150), [
    "mouseMove stage null false 150,150 @150,150",
    "mouseOut b null false 50,150 @150,150",
    "rollOut b null false 50,150 @150,150",
  ]);
});

test("a pressed button dragged off shows over, and down again back on; one dragged onto stays up", {
  skip,
}, async () => {
  const { input, player } = await gaps();
  const btn = player.root.children.find((c) => c instanceof ButtonObject) as ButtonObject;
  // The state a step leaves the button in, and the events it traced.
  const step = (type: "move" | "down" | "up", x: number, y: number) => {
    const lines = input(type, x, y).filter((line) => !line.startsWith("mouseMove"));
    return [btn.state, lines];
  };

  // The states Flash Player 32 showed: each state a sprite whose
  // ADDED_TO_STAGE traced as the button showed it (PepperFlash).
  input("move", 210, 10);
  assert.deepEqual(step("down", 210, 10), ["down", ["mouseDown btn null true 10,10 @210,10"]]);
  assert.deepEqual(step("move", 300, 10), [
    "over",
    [
      "mouseOut btn null true 100,10 @300,10",
      "rollOut btn null true 100,10 @300,10",
      "rollOut root null true 300,10 @300,10",
    ],
  ]);
  assert.deepEqual(step("move", 220, 10), [
    "down",
    [
      "rollOver btn null true 20,10 @220,10",
      "rollOver root null true 220,10 @220,10",
      "mouseOver btn null true 20,10 @220,10",
    ],
  ]);
  assert.deepEqual(step("up", 220, 10), [
    "over",
    ["mouseUp btn null false 20,10 @220,10", "click btn null false 20,10 @220,10"],
  ]);

  // Released off it, it is up.
  input("down", 220, 10);
  assert.deepEqual(step("move", 300, 10)[0], "over");
  assert.deepEqual(step("up", 300, 10), ["up", ["mouseUp stage null false 300,10 @300,10"]]);

  // Pressed elsewhere and dragged on, it stays up until the release over it.
  assert.deepEqual(step("down", 300, 10), ["up", ["mouseDown stage null true 300,10 @300,10"]]);
  assert.deepEqual(step("move", 220, 20)[0], "up");
  assert.deepEqual(step("up", 220, 20), ["over", ["mouseUp btn null false 20,20 @220,20"]]);

  // Pressed on it and dragged onto another object, over; released there, up.
  input("down", 220, 20);
  assert.deepEqual(step("move", 150, 20), [
    "over",
    [
      "mouseOut btn b true -50,20 @150,20",
      "rollOut btn b true -50,20 @150,20",
      "rollOver b btn true 50,20 @150,20",
      "mouseOver b btn true 50,20 @150,20",
    ],
  ]);
  assert.deepEqual(step("up", 150, 20), ["up", ["mouseUp b null false 50,20 @150,20"]]);
});

test("a double click on an object whose doubleClickEnabled is true sends doubleClick for the second click", {
  skip,
}, async () => {
  const { input, cmd } = await gaps();
  // A click's events, the press 30 ms after the step before it.
  const click = (x: number, y: number) => [...input("down", x, y, 30), ...input("up", x, y, 30)];
  cmd("set", "a", "doubleClickEnabled", true);
  input("move", 10, 10);

  // What Flash Player 32 traced: the second click of a double is the
  // doubleClick, in the click's place, and the third a click again.
  assert.deepEqual(click(10, 10), [
    "mouseDown a null true 10,10 @10,10",
    "mouseUp a null false 10,10 @10,10",
    "click a null false 10,10 @10,10",
  ]);
  assert.deepEqual(click(10, 10), [
    "mouseDown a null true 10,10 @10,10",
    "mouseUp a null false 10,10 @10,10",
    "doubleClick a null false 10,10 @10,10",
  ]);
  assert.deepEqual(click(10, 10).at(-1), "click a null false 10,10 @10,10");

  // Two clicks 600 ms apart are two clicks.
  input("move", 11, 11, 800);
  click(10, 10);
  input("move", 10, 10, 570);
  assert.deepEqual(click(10, 10).at(-1), "click a null false 10,10 @10,10");

  // Only the target's own doubleClickEnabled counts, not its parent's.
  input("move", 30, 30, 800);
  click(30, 30);
  assert.deepEqual(click(30, 30).at(-1), "click a1 null false 10,10 @30,30");

  // A second press released elsewhere is no click, nor a double.
  input("move", 10, 10, 800);
  click(10, 10);
  input("down", 10, 10, 30);
  assert.deepEqual(input("up", 110, 10, 30).at(-1), "mouseUp b null false 10,10 @110,10");

  // Nor is one whose first press was on another object, there: Flash
  // Player 32 sent a click where the browser counted a double whose first
  // click was on another object.
  cmd("set", "b", "doubleClickEnabled", true);
  input("move", 10, 10, 800);
  click(10, 10);
  cmd("set", "b", "x", 0);
  assert.deepEqual(click(10, 10).at(-1), "click b null false 10,10 @10,10");
});
