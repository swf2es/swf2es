// The player losing and gaining the system's focus: DEACTIVATE and
// ACTIVATE broadcast to every EventDispatcher that listens, once a change
// and never inside a script, and the browser's focus, blur and visibility
// that tell a host of it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { bindActivation } from "../../../../packages/player/dist/input/activation.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { WeakTargets } from "../../../../packages/player/dist/scripting/events.js";
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

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** Until what setActive asked for has applied: once the calling JavaScript returns. */
const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve));

/**
 * The root, a sprite and a plain EventDispatcher off the list, and a
 * two-frame clip off the list, made first, that listens for DEACTIVATE
 * alone and traces its frames; a key traces itself as it starts and ends, the print hook
 * between them standing for the page's JavaScript.
 */
const SOURCE = `package {
  import flash.display.MovieClip;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.EventDispatcher;
  import flash.events.KeyboardEvent;
  public class ActivationMain extends Sprite {
    private var _orphan:Sprite = new Sprite();
    private var _plain:EventDispatcher = new EventDispatcher();
    private var _ticker:Ticker = new Ticker();
    public function ActivationMain() {
      addEventListener(Event.DEACTIVATE, heard);
      addEventListener(Event.ACTIVATE, heard);
      _orphan.name = "orphan";
      _orphan.addEventListener(Event.DEACTIVATE, heard);
      _orphan.addEventListener(Event.ACTIVATE, heard);
      _plain.addEventListener(Event.DEACTIVATE, heard);
      _plain.addEventListener(Event.ACTIVATE, heard);
      stage.addEventListener(KeyboardEvent.KEY_DOWN, function(e:KeyboardEvent):void {
        trace("key", e.keyCode, "start");
        trace("key", e.keyCode, "end");
      });
    }
    private function heard(e:Event):void {
      var name:String = e.target is Sprite ? Sprite(e.target).name : "plain";
      trace(e.type, name, e.target == e.currentTarget, e.eventPhase, e.bubbles, e.cancelable);
    }
  }
  public class Ticker extends MovieClip {
    public function Ticker() {
      name = "ticker";
      addFrameScript(0, tick, 1, tick);
      addEventListener(Event.DEACTIVATE, function(e:Event):void { trace("deactivate ticker"); });
    }
    private function tick():void {
      trace("tick");
    }
  }
}`;

async function played(onPrint: (line: string, player: Player) => void = () => {}) {
  const swf = w.swf({
    version: 10,
    width: 20,
    height: 20,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.sprite(2, 2, [w.showFrame(), w.showFrame(), w.end()]),
      w.doAbc(compiler(out)("ActivationMain", SOURCE)),
      w.symbolClass([
        [0, "ActivationMain"],
        [2, "Ticker"],
      ]),
      w.showFrame(),
      w.end(),
    ],
  });
  const lines: string[] = [];
  let player: Player | null = null;
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => {
      lines.push(line);
      if (player) {
        onPrint(line, player);
      }
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  player = new Player(swf, scripting);
  await player.start();
  return { player, lines };
}

const own = (lines: string[]) => lines.filter((line) => line !== "tick");

test("DEACTIVATE and ACTIVATE reach every listening EventDispatcher, on the list or not, once a change", {
  skip,
}, async () => {
  const { player, lines } = await played();
  assert.equal(player.isActive, true);
  assert.deepEqual(own(lines), []);

  const changes = player.changes;
  player.setActive(false);
  // Told again, nothing changed: nothing is sent.
  player.setActive(false);
  await settled();

  assert.equal(player.isActive, false);
  assert.ok(player.changes > changes);
  assert.deepEqual(own(lines.splice(0)), [
    "deactivate ticker",
    "deactivate root1 true 2 false false",
    "deactivate orphan true 2 false false",
    "deactivate plain true 2 false false",
  ]);

  player.setActive(true);
  // A frame applies it too, before its scripts; once.
  player.tick();
  await settled();

  assert.deepEqual(own(lines), [
    "activate root1 true 2 false false",
    "activate orphan true 2 false false",
    "activate plain true 2 false false",
  ]);
});

test("a clip off the list that listens for DEACTIVATE alone stops playing as any other", {
  skip,
}, async () => {
  const { player, lines } = await played();
  const ticks = () => lines.filter((line) => line === "tick").length;
  for (let i = 0; i < 200; i++) {
    player.tick();
  }

  const stopped = ticks();
  for (let i = 0; i < 50; i++) {
    player.tick();
  }

  assert.ok(stopped > 100 && stopped < 200, `${stopped} ticks`);
  assert.equal(ticks(), stopped);

  // Still alive, held by the root: it hears the broadcast.
  player.setActive(false);
  await settled();

  assert.ok(lines.includes("deactivate ticker"));
});

test("a focus change during a script applies after it, and a blur and focus in one sends nothing", {
  skip,
}, async () => {
  const { player, lines } = await played((line, p) => {
    switch (line) {
      case "key 65 start":
        p.setActive(false);
        break;
      case "key 66 start":
        p.setActive(true);
        p.setActive(false);
        p.setActive(true);
        break;
      case "key 67 start":
        p.setActive(false);
        p.setActive(true);
        break;
    }
  });
  player.keyboard?.handle("down", { keyCode: 65, charCode: 97 });
  await settled();
  player.keyboard?.handle("down", { keyCode: 66, charCode: 98 });
  await settled();
  player.keyboard?.handle("down", { keyCode: 67, charCode: 99 });
  await settled();

  assert.deepEqual(own(lines), [
    "key 65 start",
    "key 65 end",
    "deactivate ticker",
    "deactivate root1 true 2 false false",
    "deactivate orphan true 2 false false",
    "deactivate plain true 2 false false",
    "key 66 start",
    "key 66 end",
    "activate root1 true 2 false false",
    "activate orphan true 2 false false",
    "activate plain true 2 false false",
    "key 67 start",
    "key 67 end",
  ]);
});

test("activation's listeners are held weakly, in the order they first listened", async () => {
  const targets = new WeakTargets();
  const kept = { name: "kept" } as never;
  const removed = { name: "removed" } as never;
  targets.add(kept);
  targets.add(removed);
  targets.add(kept);
  targets.delete(removed);
  (() => {
    targets.add({ name: "dropped" } as never);
  })();
  // A WeakRef holds its target to the end of the job that made it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  gc();

  assert.deepEqual(targets.live(), [kept]);
});

/** A window, its document and an element as bindActivation listens to them. */
function page(state: { focused?: boolean; visibilityState?: string } = {}) {
  const win = new EventTarget() as EventTarget & { document: unknown };
  const doc = Object.assign(new EventTarget(), {
    visibilityState: state.visibilityState ?? "visible",
    focused: state.focused ?? true,
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

  assert.deepEqual(told, [true, false, true, false, true]);

  unbind();
  win.dispatchEvent(new Event("blur"));

  assert.deepEqual(told, [true, false, true, false, true]);
});

test("a page without focus or hidden as it binds starts the player inactive", () => {
  assert.deepEqual(page({ focused: false }).told, [false]);
  assert.deepEqual(page({ visibilityState: "hidden" }).told, [false]);

  // The element focused is the page's focus too.
  const { element, told } = page({ focused: false });
  element.dispatchEvent(new Event("focusin"));

  assert.deepEqual(told, [false, true]);
});

test("the focus leaving the element for the page deactivates, but not within it or with the window", () => {
  const { win, doc, element, inside, told, focusout } = page();
  // Within the element: it still hears the keys.
  focusout(inside);
  assert.deepEqual(told, [true]);

  // To the page around it.
  focusout(null);
  element.dispatchEvent(new Event("focusin"));
  assert.deepEqual(told, [true, false, true]);

  // The window's blur takes the element's focus as well, which the window's
  // focus gives back: the element's focusout is not the page's.
  doc.focused = false;
  focusout(null);
  win.dispatchEvent(new Event("blur"));
  doc.focused = true;
  win.dispatchEvent(new Event("focus"));
  element.dispatchEvent(new Event("focusin"));

  assert.deepEqual(told, [true, false, true, false, true, true]);
});
