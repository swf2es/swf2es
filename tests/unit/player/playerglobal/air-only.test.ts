// AIR's own classes, as a SWF sees them: on the web, absent, as in Flash
// Player 32's plugin, which refuses each by name with ReferenceError #1065
// and stops a SWF whose class extends one; in AIR (Scripting's `air`),
// defined. Those Flash's playerglobal leaves unmarked are hidden by
// tools/playerglobal-air.ts, the rest by their own API versions.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { Player } from "../../../../packages/player/dist/player.js";
import { playerglobalLibrary } from "../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";
import * as w from "../../../swf-writer.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../out/player-air-only/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** Some of each: unmarked in Flash's playerglobal, AIR's by version, Flash Player's, and kept. */
const NAMES = [
  "flash.desktop.NativeApplication",
  "flash.display.NativeWindow",
  "flash.html.HTMLLoader",
  "flash.filesystem.File",
  "flash.events.InvokeEvent",
  "Vector.<flash.filesystem.File>",
  "flash.desktop.Clipboard",
  "flash.net.URLRequestDefaults",
];

const LOOKUPS = `package {
  import flash.desktop.NativeApplication;
  import flash.display.Sprite;
  import flash.system.ApplicationDomain;
  import flash.utils.describeType;
  import flash.utils.getDefinitionByName;

  public class Lookups extends Sprite {
    public function Lookups() {
      for each (var name:String in ${JSON.stringify(NAMES)}) {
        var found:String;
        try {
          found = String(getDefinitionByName(name));
        } catch (e:Error) {
          found = e.name + " " + e.errorID;
        }
        trace(name, ApplicationDomain.currentDomain.hasDefinition(name), found);
      }
      try {
        trace("class", NativeApplication);
      } catch (e:Error) {
        trace("class", e.name, e.errorID);
      }
      trace("stage.nativeWindow", describeType(stage).toXMLString().indexOf("nativeWindow") >= 0);
    }
  }
}
`;

const SUBCLASS = `package {
  import flash.display.NativeWindow;
  import flash.display.NativeWindowInitOptions;

  public class Window extends NativeWindow {
    public function Window() {
      super(new NativeWindowInitOptions());
    }
  }
}
`;

/** The libraries with our playerglobal, whatever SWF2ES_PLAYERGLOBAL says: Flash's marks none of AIR_ONLY. */
function libraries(): Uint8Array[] {
  return [libraryAbcs(`${out}libraries/`)[0], playerglobalLibrary];
}

async function play(swf: Uint8Array, air: boolean): Promise<string[]> {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    air,
  });
  await scripting.loadLibraries(libraries());
  const player = new Player(swf, scripting);
  try {
    await player.start();
  } finally {
    player.destroy();
  }

  return lines;
}

test("on the web AIR's classes are not defined, by name or by code", { skip }, async () => {
  const lines = await play(bare(compiler(out)("Lookups", LOOKUPS), 1, "Lookups"), false);

  // As Flash Player 32's plugin traces them.
  assert.deepEqual(lines, [
    "flash.desktop.NativeApplication false ReferenceError 1065",
    "flash.display.NativeWindow false ReferenceError 1065",
    "flash.html.HTMLLoader false ReferenceError 1065",
    "flash.filesystem.File false ReferenceError 1065",
    "flash.events.InvokeEvent false ReferenceError 1065",
    "Vector.<flash.filesystem.File> false ReferenceError 1065",
    "flash.desktop.Clipboard true [class Clipboard]",
    // Kept, though the plugin has none (tools/playerglobal-air.ts).
    "flash.net.URLRequestDefaults true [class URLRequestDefaults]",
    "class ReferenceError 1065",
    "stage.nativeWindow false",
  ]);
});

test("in AIR they are", { skip }, async () => {
  const lines = await play(bare(compiler(out)("Lookups", LOOKUPS), 1, "Lookups"), true);

  assert.deepEqual(lines, [
    "flash.desktop.NativeApplication true [class NativeApplication]",
    "flash.display.NativeWindow true [class NativeWindow]",
    "flash.html.HTMLLoader true [class HTMLLoader]",
    "flash.filesystem.File true [class File]",
    "flash.events.InvokeEvent true [class InvokeEvent]",
    "Vector.<flash.filesystem.File> true [class Vector.<flash.filesystem::File>]",
    "flash.desktop.Clipboard true [class Clipboard]",
    "flash.net.URLRequestDefaults true [class URLRequestDefaults]",
    "class [class NativeApplication]",
    "stage.nativeWindow true",
  ]);
});

test("a class that extends one links in AIR alone", { skip }, async () => {
  const window = compiler(out)("Window", SUBCLASS);
  const swf = w.swf({
    width: 100,
    height: 50,
    frameRate: 24,
    frameCount: 1,
    tags: [
      w.fileAttributes(true),
      w.doAbc(compiler(out)("Lookups", LOOKUPS), "Lookups"),
      w.doAbc(window, "Window", true),
      w.symbolClass([[0, "Lookups"]]),
      w.showFrame(),
      w.end(),
    ],
  });

  // Flash Player's plugin stops the SWF at the DoABC, Class not found.
  await assert.rejects(play(swf, false), /VerifyError #1014/);
  assert.equal((await play(swf, true)).length, 10);
});
