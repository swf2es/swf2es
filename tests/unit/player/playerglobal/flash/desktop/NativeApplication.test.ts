// NativeApplication and Stage.nativeWindow over a host's AirApplication, as
// adl (AIR 51.3) has them: the launch's InvokeEvent handed to each listener
// once it listens, the descriptor, and the window's bounds, title and
// state. What the traces expect is what adl traced for the same scripts.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../../../oracle/oracle.ts";
import type { AirApplication, WindowBounds } from "../../../../../../packages/player/dist/index.js";
import { Player } from "../../../../../../packages/player/dist/player.js";
import { playerglobalLibrary } from "../../../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../../../packages/player/dist/scripting.js";
import { bare } from "../../../../../player/cases.ts";
import { libraryAbcs } from "../../../../../player/libraries.ts";
import { compiler } from "../../../../../player/scripts.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../../../out/player-native-application/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

const DESCRIPTOR = `<?xml version="1.0" encoding="utf-8" ?>
<application xmlns="http://ns.adobe.com/air/application/51.3">
  <id>org.swf2es.facts</id>
  <filename>Facts</filename>
  <versionNumber>0.1.0</versionNumber>
  <initialWindow><content>Facts.swf</content><title>Air Facts</title></initialWindow>
  <supportedProfiles>extendedDesktop</supportedProfiles>
</application>`;

/** Plays `source`'s class `name` in AIR for `frames` frames with `application`; what it traced. */
async function play(
  name: string,
  source: string,
  frames: number,
  application: AirApplication | null,
): Promise<string[]> {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    air: true,
    application,
  });
  await scripting.loadLibraries([libraryAbcs(`${out}libraries/`)[0], playerglobalLibrary]);
  const player = new Player(bare(compiler(out)(name, source), 1, name), scripting);
  try {
    await player.start();
    lines.push("-- started");
    for (let i = 0; i < frames; i++) {
      player.tick();
    }
  } finally {
    player.destroy();
  }

  return lines;
}

/** A window that keeps what it is told, at `bounds`, its stage `offset` in from its corner. */
function window(bounds: WindowBounds, title: string) {
  const state = { bounds, title, visible: false };
  return {
    state,
    window: {
      bounds: () => ({ ...state.bounds }),
      setBounds: (b: WindowBounds) => {
        state.bounds = { ...b };
      },
      title: () => state.title,
      setTitle: (t: string) => {
        state.title = t;
      },
      displayState: () => "normal",
      active: () => true,
      visible: () => state.visible,
      stageOffset: () => ({ x: 4, y: 30 }),
    },
  };
}

const INVOKE = `package {
  import flash.desktop.NativeApplication;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.InvokeEvent;

  public class Invoke extends Sprite {
    public function Invoke() {
      var app:NativeApplication = NativeApplication.nativeApplication;
      trace("ctor: adding");
      app.addEventListener(InvokeEvent.INVOKE, function(i:InvokeEvent):void {
        trace("invoke A", i.target == app, i.currentTarget == app, i.eventPhase, i.bubbles, i.cancelable, i.arguments.join("|"), i.reason);
      });
      trace("ctor: added");
      app.addEventListener(InvokeEvent.INVOKE, function(i:InvokeEvent):void {
        trace("invoke B");
      });
      trace("ctor: added B");
      var frames:int = 0;
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        frames++;
        trace("frame", frames);
        if (frames == 2) {
          trace("frame 2: adding C");
          app.addEventListener(InvokeEvent.INVOKE, function(i:InvokeEvent):void { trace("invoke C"); });
          trace("frame 2: added C");
          app.dispatchEvent(new InvokeEvent(InvokeEvent.INVOKE, false, false, null, ["manual"]));
          trace("frame 2: dispatched manual");
        }
      });
    }
  }
}
`;

test("the launch reaches each invoke listener once it listens, as adl hands it out", {
  skip,
}, async () => {
  const lines = await play("Invoke", INVOKE, 3, {
    descriptor: DESCRIPTOR,
    id: "org.swf2es.facts",
    arguments: ["x", "y"],
  });

  assert.deepEqual(lines, [
    "ctor: adding",
    "ctor: added",
    "ctor: added B",
    // After the constructor, before the first frame's ENTER_FRAME.
    "invoke A true true 2 false false x|y standard",
    "invoke B",
    "-- started",
    "frame 1",
    "frame 2",
    "frame 2: adding C",
    "frame 2: added C",
    // A script's own InvokeEvent goes to every listener, as any event does.
    "invoke A true true 2 false false manual standard",
    "invoke B",
    "invoke C",
    "frame 2: dispatched manual",
    // The launch to C alone, at the end of the frame it listened in.
    "invoke C",
    "frame 3",
  ]);
});

const FACTS = `package {
  import flash.desktop.NativeApplication;
  import flash.display.NativeWindow;
  import flash.display.Sprite;
  import flash.geom.Point;

  public class Facts extends Sprite {
    public function Facts() {
      var a:NativeApplication = NativeApplication.nativeApplication;
      trace("app", a.runtimeVersion, a.runtimePatchLevel, a.applicationID, "[" + a.publisherID + "]", a.autoExit, a.idleThreshold, a.systemIdleMode, a.executeInBackground, a.menu);
      try {
        trace(a.startAtLogin);
      } catch (e:Error) {
        trace("startAtLogin", e.errorID);
      }
      var w:NativeWindow = stage.nativeWindow;
      trace("windows", a.openedWindows.length, a.openedWindows[0] == w, a.activeWindow == w);
      trace("descriptor", a.applicationDescriptor.name(), a.applicationDescriptor.children().length());
      trace("window", w.width, w.height, w.x, w.y, w.title, w.displayState, w.active, w.visible, w.closed, w.stage == stage);
      trace("chrome", w.systemChrome, w.transparent, w.type, w.minimizable, w.maximizable, w.resizable, w.alwaysInFront, w.menu);
      trace("screen", w.globalToScreen(new Point(10, 20)));
      w.title = "Changed";
      w.width = 420;
      trace("after set", w.title, w.width, w.height, w.bounds);
      a.exit(3);
    }
  }
}
`;

test("the application and its window are the host's, as adl reports its own", {
  skip,
}, async () => {
  const { state, window: host } = window({ x: 0, y: 0, width: 400, height: 300 }, "Air Facts");
  let exited: number | null = null;
  const lines = await play("Facts", FACTS, 0, {
    descriptor: DESCRIPTOR,
    id: "org.swf2es.facts",
    arguments: [],
    window: host,
    exit: (code) => {
      exited = code;
    },
  });

  assert.deepEqual(lines.slice(0, -1), [
    "app 51.3.1.2 2 org.swf2es.facts [] true 300 normal false null",
    // adl's, run from its SDK rather than installed.
    "startAtLogin 2014",
    "windows 1 true true",
    "descriptor http://ns.adobe.com/air/application/51.3::application 5",
    "window 400 300 0 0 Air Facts normal true false false true",
    "chrome standard false normal true true true false null",
    // The stage's corner on the screen is past the frame's border and title bar.
    "screen (x=14, y=50)",
    "after set Changed 420 300 (x=0, y=0, w=420, h=300)",
  ]);
  assert.deepEqual(state.bounds, { x: 0, y: 0, width: 420, height: 300 });
  assert.equal(state.title, "Changed");
  assert.equal(exited, 3);
});

const NO_WINDOW = `package {
  import flash.desktop.NativeApplication;
  import flash.display.Sprite;
  import flash.events.InvokeEvent;

  public class NoWindow extends Sprite {
    public function NoWindow() {
      trace("window", stage.nativeWindow, NativeApplication.nativeApplication.openedWindows.length);
      NativeApplication.nativeApplication.addEventListener(InvokeEvent.INVOKE, function(i:InvokeEvent):void {
        trace("invoke", i.arguments.length);
      });
    }
  }
}
`;

test("without the host's application there is no window, and a launch with no arguments", {
  skip,
}, async () => {
  const lines = await play("NoWindow", NO_WINDOW, 0, null);

  assert.deepEqual(lines, ["window null 0", "invoke 0", "-- started"]);
});
