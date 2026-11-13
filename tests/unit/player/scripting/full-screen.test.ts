// Stage.displayState, fullScreenSourceRect and FullScreenEvent over a
// host's FullScreenHost, as adl (AIR 51.3) has them. FACTS is a script adl
// ran in a 1024 by 768 screen, its window's stage 542 by 366 in noScale;
// what the first test expects is what adl traced for it, but where a
// comment says otherwise.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import type { FullScreenHost } from "../../../../packages/player/dist/index.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { playerglobalLibrary } from "../../../../packages/player/dist/playerglobal/index.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../out/player-stage-full-screen/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/** A host that keeps what it is asked, and answers as told. */
function fakeHost(options: { allow?: boolean; interactive?: boolean; grant?: boolean } = {}) {
  const state = { full: false, asked: [] as string[], grant: options.grant ?? true };
  const host: FullScreenHost = {
    allowed: (interactive) =>
      interactive ? (options.interactive ?? true) : (options.allow ?? true),
    request: (interactive) => {
      state.asked.push(interactive ? "interactive" : "request");
      state.full = state.grant;
      return state.grant;
    },
    exit: () => {
      state.asked.push("exit");
      state.full = false;
    },
  };
  return { state, host };
}

/**
 * Plays `source`'s class `name` for `frames` frames over `host`, the
 * stage 550 by 400; what it traced. The stage is placed as the web
 * element places it: in noScale it is its box, 542 by 366 or the screen's
 * 1024 by 768, or the source rect in full screen. `between` runs before
 * each frame.
 */
async function play(
  name: string,
  source: string,
  frames: number,
  host: ReturnType<typeof fakeHost> | null,
  air: boolean,
  between?: (frame: number, scripting: Scripting, lines: string[], player: Player) => void,
): Promise<string[]> {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    air,
    application: air
      ? {
          descriptor: "<application/>",
          id: "org.swf2es.facts",
          arguments: [],
          window: {
            bounds: () => ({ x: 0, y: 0, width: 550, height: 400 }),
            title: () => "",
            displayState: () => "normal",
            restore: () => {},
            active: () => true,
            visible: () => true,
            stageOffset: () => ({ x: 0, y: 0 }),
          },
        }
      : null,
    fullScreen: host?.host,
  });
  await scripting.loadLibraries([libraryAbcs(`${out}libraries/`)[0], playerglobalLibrary]);
  const player = new Player(bare(compiler(out)(name, source), 1, name, 550, 400), scripting);
  scripting.onStageLayout = () => {
    const rect = scripting.fullScreen.rect;
    const box = host?.state.full ? [1024, 768] : [542, 366];
    if (scripting.stageScaleMode === "noScale") {
      scripting.resizeStage(rect?.width ?? box[0], rect?.height ?? box[1]);
    } else {
      scripting.resizeStage(550, 400);
    }
  };
  try {
    await player.start();
    for (let i = 1; i <= frames; i++) {
      between?.(i, scripting, lines, player);
      player.tick();
    }
  } finally {
    player.destroy();
  }

  return lines;
}

const FACTS = `package {
  import flash.display.Sprite;
  import flash.display.StageDisplayState;
  import flash.events.Event;
  import flash.events.FullScreenEvent;
  import flash.geom.Rectangle;

  public class FullScreenFacts extends Sprite {
    private var frame:int = 0;

    public function FullScreenFacts() {
      trace("initial", state(), stage.allowsFullScreen, stage.allowsFullScreenInteractive);
      stage.addEventListener(FullScreenEvent.FULL_SCREEN, function(e:FullScreenEvent):void {
        trace("  event", e.type, e.fullScreen, e.interactive, e.bubbles, e.cancelable, e.target == stage, state());
      });
      stage.addEventListener(Event.RESIZE, function(e:Event):void {
        trace("  resize", state());
      });
      addEventListener(Event.ENTER_FRAME, step);
    }

    private function state():String {
      return stage.displayState + " " + stage.stageWidth + "x" + stage.stageHeight + " " + stage.fullScreenSourceRect;
    }

    private function attempt(label:String, f:Function):void {
      trace(label);
      try {
        f();
      } catch (e:Error) {
        trace("  thrown", e.name, e.errorID);
      }
      trace("  after", state());
    }

    private function step(e:Event):void {
      switch (++frame) {
        case 2:
          attempt("fullScreen", function():void { stage.displayState = StageDisplayState.FULL_SCREEN; });
          break;
        case 3:
          attempt("fullScreen again", function():void { stage.displayState = "fullScreen"; });
          attempt("to interactive", function():void { stage.displayState = "fullScreenInteractive"; });
          attempt("to fullScreen", function():void { stage.displayState = "fullScreen"; });
          break;
        case 4:
          attempt("bogus", function():void { stage.displayState = "bogus"; });
          attempt("null", function():void { stage.displayState = null; });
          attempt("NORMAL", function():void { stage.displayState = "NORMAL"; });
          break;
        case 5:
          attempt("source rect", function():void {
            var set:Rectangle = new Rectangle(10, 20, 300, 200);
            stage.fullScreenSourceRect = set;
            set.width = 7;
            var got:Rectangle = stage.fullScreenSourceRect;
            got.width = 5;
            trace("  copies", got === stage.fullScreenSourceRect, set === stage.fullScreenSourceRect);
          });
          attempt("mouseLock", function():void { stage.mouseLock = true; trace("  mouseLock", stage.mouseLock); });
          break;
        case 6:
          attempt("normal", function():void { stage.displayState = StageDisplayState.NORMAL; trace("  mouseLock", stage.mouseLock); });
          attempt("mouseLock in normal", function():void { stage.mouseLock = true; });
          attempt("mouseLock off in normal", function():void { stage.mouseLock = false; });
          attempt("normal again", function():void { stage.displayState = "normal"; });
          break;
        case 7:
          attempt("as the application", function():void {
            stage.fullScreenSourceRect = new Rectangle(0, 0, 960, 550);
            stage.displayState = StageDisplayState.FULL_SCREEN_INTERACTIVE;
          });
          break;
        case 8:
          attempt("window restore", function():void { stage.nativeWindow.restore(); });
          attempt("in and out", function():void { stage.displayState = "fullScreen"; stage.displayState = "normal"; });
          attempt("no rect", function():void { stage.fullScreenSourceRect = null; });
          break;
        case 9:
          attempt("noScale", function():void { stage.scaleMode = "noScale"; });
          attempt("fullScreen in noScale", function():void { stage.displayState = "fullScreen"; });
          break;
        case 10:
          attempt("rect in noScale", function():void { stage.fullScreenSourceRect = new Rectangle(0, 0, 400, 200); });
          attempt("no rect in noScale", function():void { stage.fullScreenSourceRect = null; });
          attempt("rect in noScale again", function():void { stage.fullScreenSourceRect = new Rectangle(0, 0, 400, 200); });
          break;
        case 11:
          attempt("normal in noScale", function():void { stage.displayState = "normal"; });
          break;
        case 12:
          attempt("fullScreen in noScale with the rect", function():void { stage.displayState = "fullScreen"; });
          break;
        case 13:
          attempt("normal", function():void { stage.displayState = "normal"; });
          trace("done");
          break;
      }
    }
  }
}
`;

/**
 * What adl traced. Leaving full screen in noScale it dispatches two RESIZEs
 * that change no size, one before the FullScreenEvent and a second after
 * the stage has its window's size again; the player dispatches a RESIZE
 * only for a size that changed.
 */
const ADL: (string | { adlOnly: string })[] = [
  "initial normal 550x400 null true false",
  "fullScreen",
  "  event fullScreen true false false false true fullScreen 550x400 null",
  "  after fullScreen 550x400 null",
  "fullScreen again",
  "  after fullScreen 550x400 null",
  "to interactive",
  "  after fullScreenInteractive 550x400 null",
  "to fullScreen",
  "  after fullScreen 550x400 null",
  "bogus",
  "  thrown ArgumentError 2008",
  "  after fullScreen 550x400 null",
  "null",
  "  thrown TypeError 2007",
  "  after fullScreen 550x400 null",
  "NORMAL",
  "  thrown ArgumentError 2008",
  "  after fullScreen 550x400 null",
  "source rect",
  "  copies false false",
  "  after fullScreen 550x400 (x=10, y=20, w=300, h=200)",
  "mouseLock",
  "  mouseLock true",
  "  after fullScreen 550x400 (x=10, y=20, w=300, h=200)",
  "normal",
  "  event fullScreen false false false false true normal 550x400 (x=10, y=20, w=300, h=200)",
  "  mouseLock false",
  "  after normal 550x400 (x=10, y=20, w=300, h=200)",
  "mouseLock in normal",
  "  thrown Error 3707",
  "  after normal 550x400 (x=10, y=20, w=300, h=200)",
  "mouseLock off in normal",
  "  thrown Error 3707",
  "  after normal 550x400 (x=10, y=20, w=300, h=200)",
  "normal again",
  "  after normal 550x400 (x=10, y=20, w=300, h=200)",
  "as the application",
  "  event fullScreen true false false false true fullScreenInteractive 550x400 (x=0, y=0, w=960, h=550)",
  "  after fullScreenInteractive 550x400 (x=0, y=0, w=960, h=550)",
  "window restore",
  "  event fullScreen false false false false true normal 550x400 (x=0, y=0, w=960, h=550)",
  "  after normal 550x400 (x=0, y=0, w=960, h=550)",
  "in and out",
  "  event fullScreen true false false false true fullScreen 550x400 (x=0, y=0, w=960, h=550)",
  "  event fullScreen false false false false true normal 550x400 (x=0, y=0, w=960, h=550)",
  "  after normal 550x400 (x=0, y=0, w=960, h=550)",
  "no rect",
  "  after normal 550x400 null",
  "noScale",
  "  resize normal 542x366 null",
  "  after normal 542x366 null",
  "fullScreen in noScale",
  "  resize normal 1024x768 null",
  "  event fullScreen true false false false true fullScreen 1024x768 null",
  "  after fullScreen 1024x768 null",
  "rect in noScale",
  "  resize fullScreen 400x200 (x=0, y=0, w=400, h=200)",
  "  after fullScreen 400x200 (x=0, y=0, w=400, h=200)",
  "no rect in noScale",
  "  resize fullScreen 1024x768 null",
  "  after fullScreen 1024x768 null",
  "rect in noScale again",
  "  resize fullScreen 400x200 (x=0, y=0, w=400, h=200)",
  "  after fullScreen 400x200 (x=0, y=0, w=400, h=200)",
  "normal in noScale",
  { adlOnly: "  resize fullScreen 400x200 (x=0, y=0, w=400, h=200)" },
  "  event fullScreen false false false false true normal 400x200 (x=0, y=0, w=400, h=200)",
  "  resize normal 542x366 (x=0, y=0, w=400, h=200)",
  { adlOnly: "  resize normal 542x366 (x=0, y=0, w=400, h=200)" },
  "  after normal 542x366 (x=0, y=0, w=400, h=200)",
  "fullScreen in noScale with the rect",
  "  resize normal 1024x768 (x=0, y=0, w=400, h=200)",
  "  event fullScreen true false false false true fullScreen 1024x768 (x=0, y=0, w=400, h=200)",
  "  resize fullScreen 400x200 (x=0, y=0, w=400, h=200)",
  "  after fullScreen 400x200 (x=0, y=0, w=400, h=200)",
  "normal",
  { adlOnly: "  resize fullScreen 400x200 (x=0, y=0, w=400, h=200)" },
  "  event fullScreen false false false false true normal 400x200 (x=0, y=0, w=400, h=200)",
  "  resize normal 542x366 (x=0, y=0, w=400, h=200)",
  { adlOnly: "  resize normal 542x366 (x=0, y=0, w=400, h=200)" },
  "  after normal 542x366 (x=0, y=0, w=400, h=200)",
  "done",
];

test("an AIR application's stage goes full screen and back as adl's does", { skip }, async () => {
  const host = fakeHost();
  const lines = await play("FullScreenFacts", FACTS, 13, host, true);

  assert.deepEqual(
    lines,
    ADL.filter((line) => typeof line === "string"),
  );
  // What the host was asked: nothing for a state it is in, or between the two kinds.
  assert.deepEqual(host.state.asked, [
    "request",
    "exit",
    "interactive",
    "exit",
    "request",
    "exit",
    "request",
    "exit",
    "request",
    "exit",
  ]);
});

const TOGGLE = `package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.FullScreenEvent;
  import flash.geom.Rectangle;

  public class Toggle extends Sprite {
    private var frame:int = 0;

    public function Toggle() {
      trace("allows", stage.allowsFullScreen, stage.allowsFullScreenInteractive);
      stage.addEventListener(FullScreenEvent.FULL_SCREEN, function(e:FullScreenEvent):void {
        trace("event", e.fullScreen, e.interactive, stage.displayState);
      });
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        frame++;
        if (frame == 1 || frame == 3) {
          try {
            stage.displayState = frame == 1 ? "fullScreen" : "fullScreenInteractive";
          } catch (e:Error) {
            trace("thrown", e.name, e.errorID);
          }
        }
        trace("frame", frame, stage.displayState);
      });
    }
  }
}
`;

test("a refusing host throws SecurityError #2152 and leaves the stage normal", {
  skip,
}, async () => {
  // Not now, as outside a user's click.
  const busy = fakeHost({ grant: false });
  assert.deepEqual(await play("Toggle", TOGGLE, 3, busy, false), [
    "allows true true",
    "thrown SecurityError 2152",
    "frame 1 normal",
    "frame 2 normal",
    "thrown SecurityError 2152",
    "frame 3 normal",
  ]);
  assert.deepEqual(busy.state.asked, ["request", "interactive"]);

  // Not at all, as without allowFullScreen: the host is not even asked.
  const never = fakeHost({ allow: false, interactive: false });
  assert.deepEqual(await play("Toggle", TOGGLE, 3, never, false), [
    "allows false false",
    "thrown SecurityError 2152",
    "frame 1 normal",
    "frame 2 normal",
    "thrown SecurityError 2152",
    "frame 3 normal",
  ]);
  assert.deepEqual(never.state.asked, []);

  // Full screen but not its interactive kind, which a stage in full screen may not turn to either.
  const plain = fakeHost({ interactive: false });
  assert.deepEqual(await play("Toggle", TOGGLE, 3, plain, false), [
    "allows true false",
    "event true false fullScreen",
    "frame 1 fullScreen",
    "frame 2 fullScreen",
    "thrown SecurityError 2152",
    "frame 3 fullScreen",
  ]);
});

test("the host's own changes reach the stage: the user's Esc, and a full screen no script asked for", {
  skip,
}, async () => {
  const host = fakeHost();
  const lines = await play("Toggle", TOGGLE, 5, host, false, (frame, scripting, traced) => {
    switch (frame) {
      case 2:
        // Esc: the host has left.
        host.state.full = false;
        scripting.fullScreen.hostChanged(false);
        traced.push("-- left");
        // Told again, it is no news.
        scripting.fullScreen.hostChanged(false);
        break;
      case 4:
        host.state.full = false;
        scripting.fullScreen.hostChanged(false);
        traced.push("-- left");
        break;
      case 5:
        // The window's own key: full screen with no script asking.
        host.state.full = true;
        scripting.fullScreen.hostChanged(true);
        traced.push("-- entered");
        break;
    }
  });

  assert.deepEqual(lines, [
    "allows true true",
    "event true false fullScreen",
    "frame 1 fullScreen",
    "event false false normal",
    "-- left",
    "frame 2 normal",
    // Flash Player's event tells the interactive kind; adl's never does.
    "event true true fullScreenInteractive",
    "frame 3 fullScreenInteractive",
    "event false false normal",
    "-- left",
    "frame 4 normal",
    "event true false fullScreen",
    "-- entered",
    "frame 5 fullScreen",
  ]);
  // The host was asked to enter twice, never to leave what it had left itself.
  assert.deepEqual(host.state.asked, ["request", "interactive"]);
});

test("without a host the stage stays normal", {
  skip,
}, async () => {
  assert.deepEqual(await play("Toggle", TOGGLE, 3, null, false), [
    "allows true false",
    "frame 1 normal",
    "frame 2 normal",
    "frame 3 normal",
  ]);
});

const KEYS = `package {
  import flash.display.Sprite;
  import flash.events.FullScreenEvent;
  import flash.events.KeyboardEvent;

  public class FullScreenKeys extends Sprite {
    public function FullScreenKeys() {
      stage.addEventListener(FullScreenEvent.FULL_SCREEN, function(e:FullScreenEvent):void {
        trace("event", e.fullScreen);
      });
      // F11 on its way down, F10 on its way up, and F9 where it is refused.
      stage.addEventListener(KeyboardEvent.KEY_DOWN, function(e:KeyboardEvent):void {
        if (e.keyCode == 122) {
          stage.displayState = stage.displayState == "normal" ? "fullScreenInteractive" : "normal";
        } else if (e.keyCode == 120) {
          try {
            stage.displayState = "fullScreen";
          } catch (error:SecurityError) {
            trace("refused", error.errorID);
          }
        } else if (e.keyCode == 119) {
          // To the state it is in, and to the other kind of full screen: nothing the host does.
          stage.displayState = stage.displayState == "normal" ? "normal" : "fullScreen";
        }
      });
      stage.addEventListener(KeyboardEvent.KEY_UP, function(e:KeyboardEvent):void {
        if (e.keyCode == 121) {
          stage.displayState = stage.displayState == "normal" ? "fullScreen" : "normal";
        }
      });
    }
  }
}
`;

test("a key whose listeners change displayState is the SWF's, which a host keeps from its own", {
  skip,
}, async () => {
  for (const air of [true, false]) {
    const host = fakeHost();
    const used: string[] = [];
    const lines = await play("FullScreenKeys", KEYS, 8, host, air, (frame, _s, _lines, player) => {
      const key = (type: "down" | "up", keyCode: number) =>
        used.push(`${type} ${keyCode} ${player.keyboard?.handle(type, { keyCode, charCode: 0 })}`);
      switch (frame) {
        case 2:
          // In by the SWF's F11: the host's key for the same, a menu's, must not take it out again.
          key("down", 122);
          key("up", 122);
          break;
        case 3:
          // Within full screen, to the state it is in and from one kind to the other: the host's still.
          key("down", 119);
          break;
        case 4:
          key("down", 122);
          break;
        case 5:
          // A key the SWF does nothing with is the host's.
          key("down", 123);
          key("down", 119);
          break;
        case 6:
          // A change on the key's way up is the SWF's too, though a host's key has acted by then.
          key("down", 121);
          key("up", 121);
          break;
        case 7:
          // A request the host refuses changes nothing.
          key("down", 121);
          key("up", 121);
          host.state.grant = false;
          key("down", 120);
          break;
        default:
      }
    });

    assert.deepEqual(used, [
      "down 122 true",
      "up 122 false",
      "down 119 false",
      "down 122 true",
      "down 123 false",
      "down 119 false",
      "down 121 false",
      "up 121 true",
      "down 121 false",
      "up 121 true",
      "down 120 false",
    ]);
    assert.deepEqual(lines, [
      "event true",
      "event false",
      "event true",
      "event false",
      "refused 2152",
    ]);
    assert.deepEqual(host.state.asked, ["interactive", "exit", "request", "exit", "request"]);
  }
});
