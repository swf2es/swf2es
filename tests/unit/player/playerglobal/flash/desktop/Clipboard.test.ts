// flash.desktop.Clipboard and System.setClipboard from AS3, as Flash Player
// has them: written only in a user's event, read only in a paste, one
// Clipboard and no other; what a script writes reaches the host.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import type { ClipboardText } from "../../../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compileScripts } from "../../../../../player/scripts.ts";

// Its own: node runs test files at once, and a compile writes its job list into `out`.
const out = fileURLToPath(new URL("../../../../out/player-clipboard/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

const SOURCE = `package {
  import flash.desktop.Clipboard;
  import flash.desktop.ClipboardFormats;
  import flash.desktop.ClipboardTransferMode;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.KeyboardEvent;
  import flash.events.MouseEvent;
  import flash.system.System;

  public class ClipboardMain extends Sprite {
    public function ClipboardMain() {
      var c:Clipboard = Clipboard.generalClipboard;
      trace("same", c == Clipboard.generalClipboard);
      attempt("new", function ():void { new Clipboard(); });
      attempt("setData", function ():void { c.setData(ClipboardFormats.TEXT_FORMAT, "x"); });
      attempt("getData", function ():void { c.getData(ClipboardFormats.TEXT_FORMAT); });
      attempt("clear", function ():void { c.clear(); });
      attempt("setClipboard", function ():void { System.setClipboard("x"); });
      trace("formats", c.formats.length, c.hasFormat(ClipboardFormats.TEXT_FORMAT));

      // A move, and the hover a press brings, are no user's gesture; the press is.
      stage.addEventListener(MouseEvent.MOUSE_MOVE, function (e:MouseEvent):void {
        attempt("move", function ():void { System.setClipboard("moved"); });
      });
      stage.addEventListener(MouseEvent.MOUSE_DOWN, function (e:MouseEvent):void {
        attempt("down", function ():void { System.setClipboard("pressed"); });
      });

      stage.focus = this;
      stage.addEventListener(KeyboardEvent.KEY_DOWN, function (e:KeyboardEvent):void {
        if (e.keyCode == 83) {
          System.setClipboard("from setClipboard");
          return;
        }

        c.clear();
        c.setData(ClipboardFormats.TEXT_FORMAT, "written");
        c.setData(ClipboardFormats.HTML_FORMAT, "<b>written</b>");
        c.setData("custom", {n: 7});
        trace("formats", c.formats.sort());
      });
      addEventListener(Event.COPY, function (e:Event):void {
        c.clear();
        c.setData(ClipboardFormats.TEXT_FORMAT, "copied");
        c.setData("custom", {n: 8});
      });
      addEventListener(Event.PASTE, function (e:Event):void {
        var custom:Object = c.getData("custom");
        var clone:Object = c.getData("custom", ClipboardTransferMode.CLONE_ONLY);
        trace("paste", c.getData(ClipboardFormats.TEXT_FORMAT), c.hasFormat("custom"),
          custom ? custom.n : null, clone ? clone.n : null, clone == custom);
      });
    }

    private static function attempt(name:String, f:Function):void {
      try {
        f();
        trace(name, "ok");
      } catch (e:Error) {
        trace(name, Object(e).constructor, e.errorID, e.message);
      }
    }
  }
}`;

test("generalClipboard and setClipboard keep Flash Player's rules, and reach the host", {
  skip,
}, async () => {
  const abc = compileScripts([{ name: "ClipboardMain", source: SOURCE }], out).get(
    "ClipboardMain",
  ) as Uint8Array;
  const lines: string[] = [];
  const written: ClipboardText[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    clipboard: { write: (data) => written.push(data) },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(abc, 1, "ClipboardMain"), scripting);
  await player.start();
  const keyboard = player.keyboard;
  assert.ok(keyboard);

  assert.deepEqual(lines.splice(0), [
    "same true",
    "new [class IllegalOperationError] 2178 Error #2178",
    "setData [class SecurityError] 0 Writing to clipboard not permitted in this context",
    "getData [class SecurityError] 0 Reading from clipboard not permitted in this context",
    "clear [class SecurityError] 2191 Error #2191",
    "setClipboard [class Error] 2176 Error #2176",
    "formats 0 false",
  ]);

  // A key handler writes; the host gets the text and HTML once the key is handled.
  keyboard.handle("down", { keyCode: 65, charCode: 97 });
  assert.deepEqual(lines.splice(0), ["formats air:html,air:text,custom"]);
  assert.deepEqual(written.splice(0), [{ text: "written", html: "<b>written</b>" }]);
  keyboard.handle("down", { keyCode: 83, charCode: 115 });
  assert.deepEqual(written.splice(0), [{ text: "from setClipboard" }]);

  // A move posted before a press is handled before the press's gesture begins.
  const pointer = player.pointer;
  assert.ok(pointer);
  pointer.post({ x: 10, y: 10 });
  pointer.handle("down", { x: 10, y: 10, button: 0 });
  assert.deepEqual(lines.splice(0), ["move [class Error] 2176 Error #2176", "down ok"]);
  assert.deepEqual(written.splice(0), [{ text: "pressed" }]);

  // A copy the host's event carries: no write of its own.
  assert.deepEqual(keyboard.copy(), { text: "copied" });
  assert.deepEqual(written, []);

  // Pasted back, the SWF's own format is there still, by reference and as a copy;
  // from elsewhere, the system's text alone.
  keyboard.paste({ text: "copied" });
  keyboard.paste({ text: "elsewhere" });
  assert.deepEqual(lines.splice(0), [
    "paste copied true 8 8 false",
    "paste elsewhere false null null true",
  ]);
});
