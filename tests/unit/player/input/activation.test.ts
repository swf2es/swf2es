// The player losing and gaining the system's focus: DEACTIVATE and
// ACTIVATE broadcast to every display object that listens, once a change,
// and the browser's focus, blur and visibility that tell a host of it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { bindActivation } from "../../../../packages/player/dist/input/activation.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";
import * as w from "../../../swf-writer.ts";

// Its own: node runs test files at once, and a compile writes its job list into `out`.
const out = fileURLToPath(new URL("../../out/player-activation/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("DEACTIVATE and ACTIVATE reach every listening display object, on the list or not, once a change", {
  skip,
}, async () => {
  const source = `package {
    import flash.display.Sprite;
    import flash.events.Event;
    import flash.events.KeyboardEvent;
    public class ActivationMain extends Sprite {
      private var _orphan:Sprite = new Sprite();
      public function ActivationMain() {
        addEventListener(Event.DEACTIVATE, heard);
        addEventListener(Event.ACTIVATE, heard);
        _orphan.name = "orphan";
        _orphan.addEventListener(Event.DEACTIVATE, heard);
        _orphan.addEventListener(Event.ACTIVATE, heard);
        stage.addEventListener(KeyboardEvent.KEY_DOWN, function(e:KeyboardEvent):void {
          trace("keyDown", e.keyCode, e.shiftKey, e.ctrlKey, e.altKey);
        });
      }
      private function heard(e:Event):void {
        trace(e.type, (e.target as Sprite).name, e.target == e.currentTarget, e.eventPhase, e.bubbles,
          e.cancelable, Sprite(e.target).stage != null);
      }
    }
  }`;
  const swf = w.swf({
    version: 10,
    width: 20,
    height: 20,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.doAbc(compiler(out)("ActivationMain", source)),
      w.symbolClass([[0, "ActivationMain"]]),
      w.showFrame(),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, scripting);
  await player.start();
  assert.equal(player.isActive, true);
  assert.deepEqual(lines, []);

  player.keyboard?.handle("down", { keyCode: 16, charCode: 0, shiftKey: true });
  const changes = player.changes;
  player.setActive(false);
  // Told again, nothing changed: nothing is sent.
  player.setActive(false);

  assert.equal(player.isActive, false);
  assert.ok(player.changes > changes);
  assert.deepEqual(lines.splice(0), [
    "keyDown 16 true false false",
    "deactivate root1 true 2 false false true",
    "deactivate orphan true 2 false false false",
  ]);

  player.setActive(true);
  player.setActive(true);
  player.tick();
  // The shift's release went elsewhere: the next key has no modifier.
  player.keyboard?.handle("down", { keyCode: 65, charCode: 97 });

  assert.deepEqual(lines, [
    "activate root1 true 2 false false true",
    "activate orphan true 2 false false false",
    "keyDown 65 false false false",
  ]);
});

/** A window, its document and an element as bindActivation listens to them. */
function page() {
  const win = new EventTarget() as EventTarget & { document: unknown };
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    focused: true,
    hasFocus() {
      return this.focused;
    },
  });
  win.document = doc;
  const inside = new EventTarget();
  const element = Object.assign(new EventTarget(), {
    contains: (node: unknown) => node === inside || node === element,
  });
  const told: boolean[] = [];
  const unbind = bindActivation(
    { setActive: (active) => told.push(active) },
    win as unknown as Parameters<typeof bindActivation>[1],
    element as unknown as Parameters<typeof bindActivation>[2],
  );
  const focusout = (relatedTarget: unknown) =>
    element.dispatchEvent(Object.assign(new Event("focusout"), { relatedTarget }));
  return { win, doc, element, inside, told, unbind, focusout };
}

test("the window's blur and focus and the document's visibility deactivate and activate", () => {
  const { win, doc, told, unbind } = page();
  win.dispatchEvent(new Event("blur"));
  win.dispatchEvent(new Event("focus"));
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));

  assert.deepEqual(told, [false, true, false, true]);

  unbind();
  win.dispatchEvent(new Event("blur"));

  assert.deepEqual(told, [false, true, false, true]);
});

test("the focus leaving the element for the page deactivates, but not within it or with the window", () => {
  const { win, doc, element, inside, told, focusout } = page();
  // Within the element: it still hears the keys.
  focusout(inside);
  assert.deepEqual(told, []);

  // To the page around it.
  focusout(null);
  element.dispatchEvent(new Event("focusin"));
  assert.deepEqual(told, [false, true]);

  // The window's blur takes the element's focus as well, which the window's
  // focus gives back: the element's focusout is not the page's.
  doc.focused = false;
  focusout(null);
  win.dispatchEvent(new Event("blur"));
  doc.focused = true;
  win.dispatchEvent(new Event("focus"));
  element.dispatchEvent(new Event("focusin"));

  assert.deepEqual(told, [false, true, false, true, true]);
});
