// Touches on a host with a touch screen: Multitouch's modes, the
// TouchEvents of each point, and the mouse the primary one moves.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import type { TouchState } from "../../../../packages/player/dist/input/touch.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compileScripts } from "../../../player/scripts.ts";

// Its own: node runs test files at once, and a compile writes its job list into `out`.
const out = fileURLToPath(new URL("../../out/player-touch/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

// A box "a" holding "b", and "c" beside it; the stage traces what it hears.
const SOURCE = `package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.MouseEvent;
  import flash.events.TouchEvent;
  import flash.system.System;
  import flash.ui.Multitouch;

  public class TouchMain extends Sprite {
    private function box(name:String, x:Number, size:Number):Sprite {
      var s:Sprite = new Sprite();
      s.name = name;
      s.graphics.beginFill(0xff0000);
      s.graphics.drawRect(0, 0, size, size);
      s.x = x;
      return s;
    }

    private function heard(e:Event):void {
      var line:String = e.type + " " + e.target.name;
      if (e is TouchEvent) {
        var t:TouchEvent = TouchEvent(e);
        line += " " + t.touchPointID + " " + t.isPrimaryTouchPoint + " " + t.localX + "," + t.localY + " " + t.sizeX + "," + t.sizeY + " " + t.pressure;
        // AIR's isTouchPointCanceled, which a Flash Player SWF reads only in the event's string.
        if (String(t).indexOf("isTouchPointCanceled=true") >= 0) {
          line += " canceled";
        }
      }

      trace(line);
    }

    public function TouchMain() {
      trace(Multitouch.supportsTouchEvents, Multitouch.maxTouchPoints, Multitouch.inputMode);
      Multitouch.inputMode = "touchPoint";
      trace(Multitouch.inputMode);
      Multitouch.inputMode = "none";
      trace(Multitouch.inputMode);
      var a:Sprite = box("a", 0, 40);
      var b:Sprite = box("b", 10, 20);
      b.y = 10;
      a.addChild(b);
      addChild(a);
      addChild(box("c", 50, 40));
      for each (var type:String in ["mouseDown", "mouseUp", "click", "mouseMove", "mouseOver", "mouseOut",
          "touchBegin", "touchEnd", "touchMove", "touchOver", "touchOut", "touchTap"]) {
        stage.addEventListener(type, heard);
      }

      a.addEventListener("touchRollOver", heard);
      a.addEventListener("touchRollOut", heard);
      stage.addEventListener("touchTap", function (e:TouchEvent):void {
        System.setClipboard("tapped");
      });
      stage.addEventListener("touchOver", function (e:TouchEvent):void {
        try {
          System.setClipboard("over");
        } catch (err:Error) {
          trace("no clipboard in touchOver");
        }
      });
    }
  }
}`;

test("touches move the mouse and, in touchPoint mode, dispatch TouchEvents first", {
  skip,
}, async () => {
  const abc = compileScripts([{ name: "TouchMain", source: SOURCE }], out).get(
    "TouchMain",
  ) as Uint8Array;
  const lines: string[] = [];
  const written: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    clipboard: { write: (data) => written.push(data.text) },
    maxTouchPoints: 5,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(abc, 1, "TouchMain"), scripting);
  await player.start();
  const touch = player.touch;
  assert.ok(touch);
  // A touch screen takes every mode a script sets, and starts in gesture mode.
  assert.deepEqual(lines.splice(0), ["true 5 gesture", "touchPoint", "none"]);

  const at = (x: number, y: number, id = 1, primary = true): TouchState => ({
    x,
    y,
    id,
    primary,
    width: 2,
    height: 3,
    pressure: 0.5,
  });

  // In none mode, the primary touch is the mouse alone: moved there, pressed, released.
  touch.handle("begin", at(15, 15));
  touch.handle("end", at(15, 15));
  assert.deepEqual(lines.splice(0), [
    "mouseMove b",
    "mouseOver b",
    "mouseDown b",
    "mouseUp b",
    "click b",
  ]);

  // In touchPoint mode, each step's touch events come before its mouse events,
  // and the mouse does not move where it is already.
  scripting.inputMode = "touchPoint";
  touch.handle("begin", at(15, 15));
  touch.handle("end", at(15, 15));
  assert.deepEqual(lines.splice(0), [
    "touchRollOver a 1 true 15,15 2,3 0.5",
    "touchOver b 1 true 5,5 2,3 0.5",
    "no clipboard in touchOver",
    "touchBegin b 1 true 5,5 2,3 0.5",
    "mouseDown b",
    "touchEnd b 1 true 5,5 2,3 0.5",
    "touchTap b 1 true 5,5 2,3 0.5",
    "touchOut b 1 true 5,5 2,3 0.5",
    "touchRollOut a 1 true 15,15 2,3 0.5",
    "mouseUp b",
    "click b",
  ]);
  // The tap, a user's gesture, wrote the clipboard; the hover before it could not.
  assert.deepEqual(written.splice(0), ["tapped"]);

  // A second finger is touch events alone, and moves coalesce per point until a flush.
  touch.handle("begin", at(15, 15));
  touch.handle("begin", at(60, 5, 2, false));
  lines.splice(0);
  touch.post(at(16, 15));
  touch.post(at(17, 15));
  touch.post(at(61, 5, 2, false));
  assert.equal(lines.length, 0);
  touch.flush();
  assert.deepEqual(lines.splice(0), [
    "touchMove b 1 true 7,5 2,3 0.5",
    "mouseMove b",
    "touchMove c 2 false 11,5 2,3 0.5",
  ]);

  // A touch the browser takes back ends without a tap, and its mouse without a click.
  touch.handle("cancel", at(17, 15));
  touch.handle("end", at(61, 5, 2, false));
  assert.deepEqual(lines.splice(0), [
    "touchEnd b 1 true 7,5 2,3 0.5 canceled",
    "touchOut b 1 true 7,5 2,3 0.5",
    "touchRollOut a 1 true 17,15 2,3 0.5",
    "mouseUp b",
    "touchEnd c 2 false 11,5 2,3 0.5",
    "touchTap c 2 false 11,5 2,3 0.5",
    "touchOut c 2 false 11,5 2,3 0.5",
  ]);

  // An id begun again before its end came: the stale point goes out of what it
  // was over, and its mouse is let go without a click, before the new begin.
  touch.handle("begin", at(15, 15));
  lines.splice(0);
  touch.handle("begin", at(60, 5));
  assert.deepEqual(lines.splice(0), [
    "touchOut b 1 true 50,-5 2,3 0.5",
    "touchRollOut a 1 true 60,5 2,3 0.5",
    "mouseUp b",
    "touchOver c 1 true 10,5 2,3 0.5",
    "no clipboard in touchOver",
    "touchBegin c 1 true 10,5 2,3 0.5",
    "mouseMove c",
    "mouseOut b",
    "mouseOver c",
    "mouseDown c",
  ]);
  touch.handle("end", at(60, 5));
  lines.splice(0);

  // With AIR's mapTouchToMouse off, touchPoint mode leaves the mouse alone.
  scripting.mapTouchToMouse = false;
  touch.handle("begin", at(60, 5));
  touch.handle("end", at(60, 5));
  assert.deepEqual(
    lines.filter((line) => line.startsWith("mouse") || line.startsWith("click")),
    [],
  );
});
