// The player's AS3 half in node, without a renderer: a document class
// compiled in the oracle's container, loaded through the release
// codegen.wasm, constructed on the root with the timeline's children in
// place, its frame scripts run in frame order.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { zlibCompress } from "@swf2es/format";
import { avm2 } from "@swf2es/runtime";
import { containerEngine } from "../../../oracle/oracle.ts";
import type { Container, MovieClip } from "../../../packages/player/dist/display/display.js";
import type { SocketEndpoints } from "../../../packages/player/dist/hosts.js";
import { Player } from "../../../packages/player/dist/player.js";
import { Scripting } from "../../../packages/player/dist/scripting.js";
import { bare, boundClip, innerSwf, scripted } from "../../player/cases.ts";
import { libraryAbcs } from "../../player/libraries.ts";
import { compiler, compileScripts } from "../../player/scripts.ts";
import * as w from "../../swf-writer.ts";

// This package's own out directory: the player's tests run at the same time and use theirs.
const out = fileURLToPath(new URL("../out/player/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("a document class is constructed on the root and its frame scripts run in order", {
  skip,
}, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const abc = compileScripts(["Main"], out).get("Main") as Uint8Array;
  const player = new Player(scripted(abc), scripting);
  await player.start();

  // Constructed with frame 1's children in place, then frame 1's script.
  assert.deepEqual(lines, ["Main 1 2 1 box 10", "frame 1 1 10"]);
  const root = player.root;
  assert.ok(root.object);
  assert.equal(root.object.$display, root);
  // A main movie's document class is constructed on the stage; a Loader's content is not (see the oracle).
  assert.equal(root.parent, player.stage);
  assert.ok(player.stage.object);
  const box = root.depths.get(1) as MovieClip;
  assert.ok(box.object);
  assert.equal(box.currentFrame, 1);

  player.tick();
  assert.deepEqual(lines.slice(2), ["frame 2 2 50"]);
  // The loop back to frame 1 runs its script again; the box is the same object.
  player.tick();
  assert.deepEqual(lines.slice(3), ["frame 1 1 10"]);
  assert.equal(root.depths.get(1), box);
});

test("Socket uses a host connection and delivers data on player frames", { skip }, async () => {
  const compile = compiler(out);
  const root = compile(
    "SocketHostRoot",
    "package { import flash.display.Sprite; public class SocketHostRoot extends Sprite {} }",
  );
  const sent: Uint8Array[] = [];
  const closeCalls: number[] = [];
  let opened: ((endpoints?: SocketEndpoints) => void) | undefined;
  let received: ((bytes: Uint8Array) => void) | undefined;
  let remoteClose: (() => void) | undefined;
  let failed: ((message: string) => void) | undefined;
  const scripting = new Scripting(await createCodegen(wasm), {
    socket: {
      connect(host, port, events) {
        assert.equal(host, "example.test");
        assert.equal(port, 1234);
        opened = events.open;
        received = events.data;
        remoteClose = events.close;
        failed = events.error;
        return {
          send: (bytes) => sent.push(bytes),
          close: () => closeCalls.push(1),
        };
      },
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(root, 1, "SocketHostRoot"), scripting);
  await player.start();
  const rt = scripting.rt;
  const socket = rt.construct(rt.classNamed("flash.net::Socket")) as avm2.AsObject;
  const events: string[] = [];
  socket.$listeners = new Map(
    ["connect", "socketData", "close", "ioError"].map((type) => [
      type,
      [{ fn: { $f: () => events.push(type) }, capture: false, priority: 0 }],
    ]),
  );
  const call = (name: string, ...args: avm2.Value[]) =>
    rt.callProperty(socket, rt.publicName(name), ...args);
  const get = (name: string) => rt.getProperty(socket, rt.publicName(name));

  const ends = () =>
    ["localAddress", "localPort", "remoteAddress", "remotePort"].map((name) => get(name));

  assert.equal(get("connected"), false);
  assert.deepEqual(ends(), [null, 0, null, 0]);
  call("connect", "example.test", 1234);
  assert.equal(get("connected"), false);
  assert.deepEqual(ends(), ["", 0, "", 0]);
  opened?.({
    localAddress: "192.0.2.1",
    localPort: 50000,
    remoteAddress: "198.51.100.7",
    remotePort: 1234,
  });
  assert.deepEqual(events, []);
  assert.deepEqual(ends(), ["", 0, "", 0]);
  player.tick();
  assert.deepEqual(events, ["connect"]);
  assert.equal(get("connected"), true);
  assert.deepEqual(ends(), ["192.0.2.1", 50000, "198.51.100.7", 1234]);

  call("writeByte", 0x12);
  call("writeShort", 0x3456);
  assert.equal(get("bytesPending"), 3);
  call("flush");
  assert.deepEqual(
    sent.map((bytes) => [...bytes]),
    [[0x12, 0x34, 0x56]],
  );
  assert.equal(get("bytesPending"), 0);

  received?.(Uint8Array.from([0x41, 0x42]));
  assert.equal(get("bytesAvailable"), 0);
  player.tick();
  assert.deepEqual(events, ["connect", "socketData"]);
  assert.equal(get("bytesAvailable"), 2);
  assert.equal(call("readUnsignedByte"), 0x41);
  assert.equal(call("readUnsignedByte"), 0x42);

  call("close");
  assert.equal(get("connected"), false);
  assert.deepEqual(ends(), [null, 0, null, 0]);
  assert.equal(closeCalls.length, 1);
  remoteClose?.();
  player.tick();
  assert.deepEqual(events, ["connect", "socketData"]);

  call("connect", "example.test", 1234);
  opened?.({ localAddress: "::1", localPort: 50001, remoteAddress: "::1", remotePort: 1234 });
  player.tick();
  remoteClose?.();
  player.tick();
  assert.deepEqual(events, ["connect", "socketData", "connect", "close"]);
  assert.equal(get("connected"), false);
  // The peer's close keeps them, as adl's does.
  assert.deepEqual(ends(), ["::1", 50001, "::1", 1234]);
  assert.equal(closeCalls.length, 1);

  call("connect", "example.test", 1234);
  failed?.("Error #2031: Socket Error.");
  player.tick();
  assert.deepEqual(events, ["connect", "socketData", "connect", "close", "ioError"]);
  assert.equal(closeCalls.length, 2);
  remoteClose?.();
  player.tick();
  assert.equal(events.length, 5);
  assert.deepEqual(ends(), ["", 0, "", 0]);

  // A host that does not know the ends, as a WebSocket relay's, leaves them unknown.
  call("connect", "example.test", 1234);
  opened?.();
  player.tick();
  assert.equal(get("connected"), true);
  assert.deepEqual(ends(), ["", 0, "", 0]);
});

test("Mouse.hide and show set the host's cursor as a script calls them", { skip }, async () => {
  const lines: string[] = [];
  const compile = compiler(out);
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compile("MouseVisibility"), 1, "MouseVisibility"), scripting);
  assert.ok(player.pointer);
  player.pointer.onCursor = (cursor) => lines.push(`cursor ${cursor}`);
  await player.start();

  // At once, between the script's own lines, and only when it changes.
  assert.deepEqual(lines, [
    "cursor none",
    "hidden",
    "hidden twice",
    "cursor default",
    "shown",
    "shown twice",
  ]);
});

test("Mouse.cursor and registered cursors set the host's cursor as a script sets them", {
  skip,
}, async () => {
  const lines: string[] = [];
  const compile = compiler(out);
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(
    bare(compile("MouseCursorNatives"), 1, "MouseCursorNatives"),
    scripting,
  );
  assert.ok(player.pointer);
  player.pointer.onCursor = (cursor) => lines.push(`cursor ${describeCursor(cursor)}`);
  await player.start();

  // The refusals and MouseCursorData's own lines are the Flash case's; these show the host's
  // cursor changing at once, only when it changes, and Mouse.hide winning over a forced one.
  const shown = lines.filter((line) => !/threw|^(supports|data|hotSpot|frameRate)/.test(line));
  assert.deepEqual(shown, [
    "cursor auto",
    "cursor = arrow: arrow",
    "cursor pointer",
    "cursor = button: button",
    "cursor grab",
    "cursor = hand: hand",
    "cursor text",
    "cursor = ibeam: ibeam",
    "cursor default",
    "cursor = auto: auto",
    "cursor text",
    "cursor ibeam",
    "cursor none",
    "hidden, cursor button",
    "cursor pointer",
    "cursor default",
    "register mine: auto",
    // The first frame alone, with its hot spot.
    "cursor image 32x32 at 31,10",
    "cursor = mine: mine",
    "cursor default",
    "cursor image 32x32 at 31,10",
    "register mine again with no data: mine",
    "unregister other: mine",
    "cursor default",
    "unregister mine: auto",
    "cursor image 16x16 at 0,0",
    "cursor default",
    "register arrow: auto",
    "cursor pointer",
    "unregister button, never registered: button",
    "cursor default",
  ]);
});

/** A CSS cursor, its image as its PNG's size and its hot spot, as the host is given it. */
function describeCursor(cursor: string): string {
  const image = /^url\("data:image\/png;base64,([^"]+)"\) (\d+) (\d+), default$/.exec(cursor);
  if (!image) {
    return cursor;
  }

  const png = Buffer.from(image[1], "base64");
  return `image ${png.readUInt32BE(16)}x${png.readUInt32BE(20)} at ${image[2]},${image[3]}`;
}

test("an AS3 error tells a host the methods it was thrown in", { skip }, async () => {
  const source = `package {
    import flash.display.MovieClip;
    public class Main extends MovieClip {
      public var nothing:Object = null;
      public function Main() {
        addFrameScript(0, frame1);
      }
      private function frame1():void {
        a();
      }
      private function a():void { b(); }
      private function b():void { c(); }
      private function c():void { d(); }
      private function d():void { e(); }
      private function e():void { reachNothing(); }
      private function reachNothing():void {
        trace(nothing.field);
      }
    }
  }`;
  const errors: unknown[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: () => {},
    onUncaught: (error) => errors.push(error),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compiler(out)("ErrorStack", source)), scripting);
  await player.start();

  assert.equal(errors.length, 1);
  assert.match(scripting.rt.toString(errors[0] as avm2.Value), /1009/);
  const stack = scripting.rt.stackOf(errors[0] as avm2.Value) ?? "";
  // The method that reached null first, and the frame script six calls out, past V8's usual ten frames.
  assert.match(stack.split("\n")[0], /reachNothing/);
  assert.match(stack, /frame1/);
  assert.equal(scripting.rt.stackOf("not an error"), null);
});

test("frame scripts that send their clip to each other's frame end in a stack overflow, not the page's", {
  skip,
}, async () => {
  // In a SWF of version 10 each goto runs a cycle inside the last; Flash nests
  // them till it gives up. The player throws AS3's Error #1023 at its depth.
  const source = `package {
    import flash.display.MovieClip;
    public class Bounce extends MovieClip {
      public function Bounce() {
        addFrameScript(0, function():void { gotoAndStop(2); }, 1, function():void { gotoAndStop(1); });
      }
    }
    public class Main extends MovieClip {}
  }`;
  const swf = w.swf({
    version: 10,
    width: 20,
    height: 20,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.sprite(2, 2, [w.showFrame(), w.showFrame(), w.end()]),
      w.doAbc(compiler(out)("Bounce", source)),
      w.symbolClass([
        [0, "Main"],
        [2, "Bounce"],
      ]),
      w.place({ depth: 1, character: 2 }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
  const scripting = new Scripting(await createCodegen(wasm), { print: () => {} });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, scripting);
  await assert.rejects(player.start(), (e: unknown) => {
    assert.match(scripting.rt.toString(e as avm2.Value), /1023/);
    return true;
  });
});

test("a goto plays or stops as it happens, so the landing frame's script has the last word", {
  skip,
}, async () => {
  // adl (`goto-stops`): a deferred gotoAndStop from the clip's own script
  // stops it after the play() that follows, and gotoAndPlay from another
  // clip's script runs the landing frame's stop() inside the goto, so the
  // clip stays.
  const source = `package {
    import flash.display.MovieClip;
    public class Bound extends MovieClip {
      public function Bound() {
        addFrameScript(0, function():void { gotoAndStop(2); play(); },
          2, function():void { stop(); });
      }
    }
    public class Main extends MovieClip {
      public var bound:Bound;
      public function Main() {
        addFrameScript(1, function():void { bound.gotoAndPlay(3); });
      }
    }
  }`;
  const scripting = new Scripting(await createCodegen(wasm), { print: () => {} });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(boundClip(compiler(out)("GotoStops", source), 10, 4), scripting);
  await player.start();
  const bound = (player.root as unknown as Container).children[0] as MovieClip;
  assert.deepEqual([bound.currentFrame, bound.playing], [2, false]);

  player.tick();
  assert.deepEqual([bound.currentFrame, bound.playing], [3, false]);

  player.tick();
  assert.deepEqual([bound.currentFrame, bound.playing], [3, false]);
});

test("a frame script's goto happens though the script throws after it, as in Flash", {
  skip,
}, async () => {
  // adl: the clip goes to frame 3 and runs its script there, the error reported apart.
  const source = `package {
    import flash.display.MovieClip;
    public class Bound extends MovieClip {
      public function Bound() {
        addFrameScript(0, function():void { gotoAndStop(3); throw new Error("after the goto"); },
          2, function():void { trace("script 3"); });
      }
    }
    public class Main extends MovieClip {
      public var bound:Bound;
    }
  }`;
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(boundClip(compiler(out)("GotoThrows", source), 10, 4), scripting);
  await assert.rejects(player.start());
  const bound = (player.root as unknown as Container).children[0] as MovieClip;
  assert.equal(bound.currentFrame, 3);
  assert.deepEqual(lines, ["script 3"]);
});

test("a goto's caller goes on when a script its cycle runs throws, as in Flash", {
  skip,
}, async () => {
  // A goto from a listener, one a frame script queues, and one from another
  // clip's frame script each land on a script that throws. A SWF that loads
  // a level and goes to its first frame from a COMPLETE listener stalled
  // when the goto passed the level's error to it.
  const source = `package {
    import flash.display.MovieClip;
    import flash.events.Event;
    public class Bound extends MovieClip {
      public function Bound() {
        addFrameScript(1, function():void {
          trace("Bound script 2, goto 3");
          gotoAndStop(3);
          trace("Bound after its goto", currentFrame);
        }, 2, function():void {
          trace("Bound script 3 throws");
          throw new Error("from script 3");
        }, 3, function():void {
          trace("Bound script 4 throws");
          throw new Error("from script 4");
        });
      }
    }
    public class Main extends MovieClip {
      public var bound:Bound;
      private var n:int = 0;
      public function Main() {
        addFrameScript(2, function():void {
          try {
            trace("Main script 3, goto 4");
            bound.gotoAndStop(4);
            trace("Main script after goto", bound.currentFrame);
          } catch (error:Error) {
            trace("Main script caught", error.message);
          }
        });
        addEventListener(Event.ENTER_FRAME, enter);
      }
      private function enter(e:Event):void {
        n++;
        if (n == 1) {
          try {
            trace("Main listener, goto 2");
            bound.gotoAndStop(2);
            trace("Main listener after goto", bound.currentFrame);
          } catch (error:Error) {
            trace("Main listener caught", error.message);
          }
        } else if (n == 3) {
          bound.gotoAndStop(1);
          try {
            trace("Main listener, goto 3");
            bound.gotoAndStop(3);
            trace("Main listener after goto", bound.currentFrame);
          } catch (error:Error) {
            trace("Main listener caught", error.message);
          }
          removeEventListener(Event.ENTER_FRAME, enter);
        }
      }
    }
  }`;
  const swf = w.swf({
    version: 10,
    width: 20,
    height: 20,
    frameCount: 5,
    tags: [
      w.fileAttributes(true),
      w.sprite(2, 4, [...Array.from({ length: 4 }, () => w.showFrame()), w.end()]),
      w.doAbc(compiler(out)("GotoCycleThrows", source)),
      w.symbolClass([
        [0, "Main"],
        [2, "Bound"],
      ]),
      w.place({ depth: 1, character: 2, name: "bound" }),
      ...Array.from({ length: 5 }, () => w.showFrame()),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, scripting);
  await player.start();
  const errors: string[] = [];
  for (let frame = 2; frame <= 5; frame++) {
    try {
      player.tick();
    } catch (error) {
      errors.push(scripting.rt.toString(error as avm2.Value));
    }
  }

  // adl's output, the errors reported apart, each when its frame ends.
  assert.deepEqual(lines, [
    "Main listener, goto 2",
    "Bound script 2, goto 3",
    "Bound after its goto 2",
    "Bound script 3 throws",
    "Main listener after goto 3",
    "Main script 3, goto 4",
    "Bound script 4 throws",
    "Main script after goto 4",
    "Main listener, goto 3",
    "Bound script 3 throws",
    "Main listener after goto 3",
  ]);
  assert.deepEqual(errors, [
    "Error: from script 3",
    "Error: from script 4",
    "Error: from script 3",
  ]);
});

test("every error nothing caught is reported, and the listeners and constructors after it run, as in Flash", {
  skip,
}, async () => {
  // Main's first FRAME_CONSTRUCTED and EXIT_FRAME listeners throw, before
  // a second on Main and one on a Sprite off the display list; a listener
  // sends a clip to two frames whose scripts throw; the root's goto to its
  // second frame makes a Bad, whose constructor throws, then a Good.
  const source = `package {
    import flash.display.MovieClip;
    import flash.display.Sprite;
    import flash.events.Event;
    public class Bound extends MovieClip {
      public function Bound() {
        stop();
        addFrameScript(1, function():void { trace("Bound script 2 throws"); throw new Error("from script 2"); },
          2, function():void { trace("Bound script 3 throws"); throw new Error("from script 3"); });
      }
    }
    public class Bad extends MovieClip {
      public function Bad() { trace("making Bad"); throw new Error("from Bad"); }
    }
    public class Good extends MovieClip {
      public function Good() { trace("made Good"); }
    }
    public class Main extends MovieClip {
      public var bound:Bound;
      private var n:int = 0;
      private var other:Sprite = new Sprite();
      public function Main() {
        stop();
        addEventListener(Event.FRAME_CONSTRUCTED, function(_:Event):void {
          if (n == 1) { trace("frameConstructed 1 throws"); throw new Error("from frameConstructed"); }
        });
        addEventListener(Event.FRAME_CONSTRUCTED, function(_:Event):void {
          if (n == 1) trace("frameConstructed 2");
        });
        addEventListener(Event.EXIT_FRAME, function(_:Event):void {
          if (n == 1) { trace("exitFrame 1 throws"); throw new Error("from exitFrame"); }
        });
        addEventListener(Event.EXIT_FRAME, function(_:Event):void {
          if (n == 1) trace("exitFrame 2");
        });
        other.addEventListener(Event.EXIT_FRAME, function(_:Event):void {
          if (n == 1) trace("exitFrame other");
        });
        addEventListener(Event.ENTER_FRAME, enter);
      }
      private function enter(e:Event):void {
        n++;
        if (n == 2) {
          trace("goto 2 and 3");
          bound.gotoAndStop(2);
          bound.gotoAndStop(3);
          trace("after both gotos", bound.currentFrame);
        } else if (n == 3) {
          trace("next frame");
          gotoAndStop(2);
          trace("after root goto", numChildren);
        }
      }
    }
  }`;
  const swf = w.swf({
    version: 10,
    width: 20,
    height: 20,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.sprite(2, 3, [...Array.from({ length: 3 }, () => w.showFrame()), w.end()]),
      w.sprite(3, 1, [w.showFrame(), w.end()]),
      w.sprite(4, 1, [w.showFrame(), w.end()]),
      w.doAbc(compiler(out)("UncaughtErrors", source)),
      w.symbolClass([
        [0, "Main"],
        [2, "Bound"],
        [3, "Bad"],
        [4, "Good"],
      ]),
      w.place({ depth: 1, character: 2, name: "bound" }),
      w.showFrame(),
      w.place({ depth: 2, character: 3 }),
      w.place({ depth: 3, character: 4 }),
      w.showFrame(),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const errors: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    onUncaught: (error) => errors.push(scripting.rt.toString(error as avm2.Value)),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, scripting);
  await player.start();
  for (let frame = 2; frame <= 4; frame++) {
    player.tick();
  }

  // adl's output and the errors it reported, in order.
  assert.deepEqual(lines, [
    "frameConstructed 1 throws",
    "frameConstructed 2",
    "exitFrame 1 throws",
    "exitFrame 2",
    "exitFrame other",
    "goto 2 and 3",
    "Bound script 2 throws",
    "Bound script 3 throws",
    "after both gotos 3",
    "next frame",
    "making Bad",
    "made Good",
    "after root goto 3",
  ]);
  assert.deepEqual(errors, [
    "Error: from frameConstructed",
    "Error: from exitFrame",
    "Error: from script 2",
    "Error: from script 3",
    "Error: from Bad",
  ]);
});

test("without onUncaught, a frame throws all its errors once it has ended", { skip }, async () => {
  // Two gotos from one listener, each landing on a script that throws.
  const source = `package {
    import flash.display.MovieClip;
    import flash.events.Event;
    public class Bound extends MovieClip {
      public function Bound() {
        stop();
        addFrameScript(1, function():void { throw new Error("from script 2"); },
          2, function():void { throw new Error("from script 3"); });
      }
    }
    public class Main extends MovieClip {
      public var bound:Bound;
      public function Main() {
        addEventListener(Event.ENTER_FRAME, function(_:Event):void {
          if (bound.currentFrame == 1) {
            bound.gotoAndStop(2);
            bound.gotoAndStop(3);
          }
        });
        addEventListener(Event.EXIT_FRAME, function(_:Event):void { trace("exitFrame", bound.currentFrame); });
      }
    }
  }`;
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(boundClip(compiler(out)("UncaughtThrown", source), 10, 3), scripting);
  await player.start();
  let thrown: unknown = null;
  try {
    player.tick();
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof AggregateError);
  assert.deepEqual(
    thrown.errors.map((e) => scripting.rt.toString(e as avm2.Value)),
    ["Error: from script 2", "Error: from script 3"],
  );
  // The frame ran to its end, each goto's cycle with its EXIT_FRAME, before
  // it threw; the next has nothing to throw.
  assert.deepEqual(lines, ["exitFrame 1", "exitFrame 2", "exitFrame 3", "exitFrame 3"]);
  player.tick();
});

test("a listener's error never reaches the dispatcher, and the listeners after it run, as in Flash", {
  skip,
}, async () => {
  // Two listeners each to a script's dispatchEvent, a Loader's INIT and a
  // Timer's TIMER, the first of each throwing: dispatchEvent still returns
  // true, COMPLETE still comes, and the timer still stops after two.
  const source = `package {
    import flash.display.Loader;
    import flash.display.MovieClip;
    import flash.events.Event;
    import flash.events.EventDispatcher;
    import flash.events.TimerEvent;
    import flash.system.LoaderContext;
    import flash.utils.ByteArray;
    import flash.utils.Timer;
    public class Main extends MovieClip {
      private var timer:Timer;
      public function Main() {
        var d:EventDispatcher = new EventDispatcher();
        d.addEventListener("x", function(e:Event):void { trace("x1 throws"); throw new Error("from x1"); });
        d.addEventListener("x", function(e:Event):void { trace("x2 ran"); });
        trace("dispatch returned", d.dispatchEvent(new Event("x")));
        // An empty SWF of version 10: header, a zero rectangle, 12 fps, one frame, FileAttributes, ShowFrame, End.
        var swf:ByteArray = new ByteArray();
        for each (var b:int in [0x46, 0x57, 0x53, 10, 23, 0, 0, 0, 0, 0, 12, 1, 0, 0x44, 0x11, 8, 0, 0, 0, 0x40, 0, 0, 0]) {
          swf.writeByte(b);
        }
        var loader:Loader = new Loader();
        loader.contentLoaderInfo.addEventListener(Event.INIT, function(e:Event):void { trace("init1 throws"); throw new Error("from init1"); });
        loader.contentLoaderInfo.addEventListener(Event.INIT, function(e:Event):void { trace("init2"); });
        loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void {
          trace("complete");
          timer = new Timer(20, 2);
          timer.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void { trace("timer1 throws", timer.currentCount); throw new Error("from timer1"); });
          timer.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void { trace("timer2", timer.currentCount); });
          timer.addEventListener(TimerEvent.TIMER_COMPLETE, function(e:TimerEvent):void { trace("timer complete", timer.running); });
          timer.start();
        });
        var context:LoaderContext = new LoaderContext();
        context.allowCodeImport = true;
        loader.loadBytes(swf, context);
      }
    }
  }`;
  const lines: string[] = [];
  const errors: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    onUncaught: (error) => errors.push(scripting.rt.toString(error as avm2.Value)),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compiler(out)("UncaughtListeners", source), 1), scripting);
  await player.start();
  for (let frame = 2; frame <= 20; frame++) {
    await scripting.settled();
    player.tick();
  }

  // adl's output and the errors it reported, in order.
  assert.deepEqual(lines, [
    "x1 throws",
    "x2 ran",
    "dispatch returned true",
    "init1 throws",
    "init2",
    "complete",
    "timer1 throws 1",
    "timer2 1",
    "timer1 throws 2",
    "timer2 2",
    "timer complete false",
  ]);
  assert.deepEqual(errors, [
    "Error: from x1",
    "Error: from init1",
    "Error: from timer1",
    "Error: from timer1",
  ]);
});

test("a document class's constructor that throws is reported, and its SWF plays on, as in Flash", {
  skip,
}, async () => {
  // The main SWF's document class registers a frame script and a listener,
  // which tries a goto to a scene that does not exist, loads a SWF whose
  // document class throws and then an empty one, and throws itself.
  const compile = compiler(out);
  const inner = innerSwf(
    compile(
      "CtorThrowsInner",
      `package {
        import flash.display.MovieClip;
        public class Inner extends MovieClip {
          public function Inner() { trace("Inner throws"); throw new Error("from Inner"); }
        }
      }`,
    ),
    1,
  );
  const empty = [
    0x46, 0x57, 0x53, 10, 23, 0, 0, 0, 0, 0, 12, 1, 0, 0x44, 0x11, 8, 0, 0, 0, 0x40, 0, 0, 0,
  ];
  const source = `package {
    import flash.display.Loader;
    import flash.display.MovieClip;
    import flash.events.Event;
    import flash.system.LoaderContext;
    import flash.utils.ByteArray;
    public class Main extends MovieClip {
      public function Main() {
        addFrameScript(0, function():void { trace("script 1"); });
        var n:int = 0;
        addEventListener(Event.ENTER_FRAME, function(e:Event):void {
          n++;
          if (n <= 2) trace("enter", n);
          if (n == 1) {
            try { gotoAndStop(1, "noscene"); } catch (e:Error) { trace("caught", e.errorID); }
          }
        });
        load("A", [${Array.from(inner).join(",")}]);
        load("B", [${empty.join(",")}]);
        trace("Main throws");
        throw new Error("from Main");
      }
      private function load(name:String, bytes:Array):void {
        var swf:ByteArray = new ByteArray();
        for each (var b:int in bytes) {
          swf.writeByte(b);
        }
        var loader:Loader = new Loader();
        loader.contentLoaderInfo.addEventListener(Event.INIT, function(e:Event):void { trace("init", name, loader.content != null); });
        loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(e:Event):void { trace("complete", name); });
        var context:LoaderContext = new LoaderContext();
        context.allowCodeImport = true;
        loader.loadBytes(swf, context);
      }
    }
  }`;
  const run = async (hook: boolean) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const scripting: Scripting = new Scripting(await createCodegen(wasm), {
      print: (line) => lines.push(line),
      onUncaught: hook
        ? (error) => errors.push(scripting.rt.toString(error as avm2.Value))
        : undefined,
    });
    await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
    const player = new Player(bare(compile("CtorThrows", source), 1), scripting);
    const thrown = (run: () => void) => {
      try {
        run();
      } catch (error) {
        errors.push(scripting.rt.toString(error as avm2.Value));
      }
    };
    await player.start().catch((error: unknown) => {
      errors.push(scripting.rt.toString(error as avm2.Value));
    });
    for (let frame = 2; frame <= 4; frame++) {
      await scripting.settled();
      thrown(() => player.tick());
    }

    return { lines, errors };
  };

  // adl's output: the first frame's script still runs, before the first
  // ENTER_FRAME; a goto's own error, #2108, still reaches its caller; the
  // load whose document class throws has no INIT or COMPLETE, and the next
  // still comes.
  const lines = [
    "Main throws",
    "script 1",
    "enter 1",
    "caught 2108",
    "Inner throws",
    "init B true",
    "complete B",
    "enter 2",
  ];
  // adl reports Main's error, and prints Inner's as its debugger does.
  const errors = ["Error: from Main", "Error: from Inner"];
  assert.deepEqual(await run(true), { lines, errors });
  // Without the hook, start() throws Main's once the first frame has ended.
  assert.deepEqual(await run(false), { lines, errors });
});

test("an onUncaught that throws stops no listener, and its error comes when the frame ends", {
  skip,
}, async () => {
  const source = `package {
    import flash.display.MovieClip;
    import flash.events.Event;
    public class Main extends MovieClip {
      public function Main() {
        addEventListener(Event.EXIT_FRAME, function(e:Event):void { trace("first throws"); throw new Error("from first"); });
        addEventListener(Event.EXIT_FRAME, function(e:Event):void { trace("second"); });
      }
    }
  }`;
  const lines: string[] = [];
  const reported: unknown[] = [];
  const hookError = new Error("from the hook");
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    onUncaught: (error) => {
      reported.push(error);
      throw hookError;
    },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compiler(out)("HookThrows", source), 1), scripting);
  await assert.rejects(player.start(), (error) => error === hookError);
  assert.deepEqual(lines, ["first throws", "second"]);
  assert.equal(reported.length, 1);
});

test("scripts that catch the stack overflow of their goto cycles stop soon, not after millions of runs", {
  skip,
}, async () => {
  // Two clips that send each other to the other frame, at once, as a goto on
  // another clip is: each cycle runs inside the last, and each script
  // catches the overflow, which must not set the cycles going again.
  const source = `package {
    import flash.display.MovieClip;
    public class Bound extends MovieClip {
      public static var runs:int = 0;
      public function Bound() {
        addFrameScript(0, swap, 1, swap);
      }
      private function swap():void {
        runs++;
        var peer:MovieClip = MovieClip(parent).getChildByName(name == "a" ? "b" : "a") as MovieClip;
        try {
          peer.gotoAndStop(peer.currentFrame == 1 ? 2 : 1);
        } catch (e:Error) {}
      }
    }
    public class Main extends MovieClip {
      public var a:Bound;
      public var b:Bound;
      public function Main() {
        addEventListener("exitFrame", function(_:*):void { trace("runs", Bound.runs); });
      }
    }
  }`;
  const swf = w.swf({
    version: 10,
    width: 20,
    height: 20,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.sprite(2, 2, [w.showFrame(), w.showFrame(), w.end()]),
      w.doAbc(compiler(out)("CaughtOverflow", source)),
      w.symbolClass([
        [0, "Main"],
        [2, "Bound"],
      ]),
      w.place({ depth: 1, character: 2, name: "a" }),
      w.place({ depth: 2, character: 2, name: "b" }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (line) => lines.push(line) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, scripting);
  await player.start();
  const runs = Number(lines.at(-1)?.split(" ")[1]);
  // The chain to the overflow, then the frame's own pass, bounded by its
  // rounds, not cycles started over.
  assert.ok(runs > 256 && runs < 10000, `${runs} runs`);
});

test("a bitmap a timeline places is a Bitmap, its bound class its data's with HasImage alone", {
  skip,
}, async () => {
  const compile = compiler(out);
  const data = compile(
    "PlacedData",
    'package { import flash.display.BitmapData; public class PlacedData extends BitmapData { public function PlacedData(w:int = -1, h:int = -1) { super(w, h); trace("data", w, h, arguments.length); } } }',
  );
  const root = compile(
    "PlacedRoot",
    "package { import flash.display.*; import flash.utils.*; public class PlacedRoot extends Sprite { public function PlacedRoot() { var b:Bitmap = getChildAt(0) as Bitmap; trace(getQualifiedClassName(b.bitmapData), b.bitmapData.width, b.bitmapData.getPixel32(1, 0).toString(16)); } } }",
  );
  // The same, its first frame empty: a jump to frame 2 places the bitmap.
  const seeking = compile(
    "SeekRoot",
    "package { import flash.display.*; import flash.utils.*; public class SeekRoot extends MovieClip { public function SeekRoot() { gotoAndStop(2); var b:Bitmap = getChildAt(0) as Bitmap; trace(getQualifiedClassName(b.bitmapData), b.bitmapData.width); } } }",
  );
  const pixels = Uint8Array.from([0xff, 1, 2, 3, 0x80, 0x40, 0x20, 0x10]);
  const bitmapSwf = (hasImage: boolean, seek = false) =>
    w.swf({
      width: 100,
      height: 50,
      frameCount: seek ? 2 : 1,
      tags: [
        w.fileAttributes(true),
        w.tag(36, Uint8Array.from([1, 0, 5, 2, 0, 1, 0, ...zlibCompress(pixels)]), true),
        w.doAbc(data, "PlacedData"),
        w.doAbc(seek ? seeking : root, seek ? "SeekRoot" : "PlacedRoot"),
        w.symbolClass([
          [1, "PlacedData"],
          [0, seek ? "SeekRoot" : "PlacedRoot"],
        ]),
        ...(seek ? [w.showFrame()] : []),
        w.place({ depth: 1, character: 1, hasImage: hasImage || undefined }),
        w.showFrame(),
        w.end(),
      ],
    });

  const run = async (hasImage: boolean, seek = false) => {
    const lines: string[] = [];
    const scripting = new Scripting(await createCodegen(wasm), {
      print: (line) => lines.push(line),
      debugger: true,
    });
    await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
    const player = new Player(bitmapSwf(hasImage, seek), scripting);
    const error = await player.start().then(
      () => null,
      (e: unknown) => scripting.rt.toString(e as avm2.Value),
    );
    return { lines, error };
  };

  // As Flash Pro places one: the class constructed with (1, 1), the pixels its own.
  assert.deepEqual(await run(true), {
    lines: ["data 1 1 2", "PlacedData 2 807f4020"],
    error: null,
  });
  // A jump to the frame that places it constructs it alike.
  assert.deepEqual(await run(true, true), { lines: ["data 1 1 2", "PlacedData 2"], error: null });
  // Without HasImage Flash takes the class for a display object's: constructed bare, then refused.
  const bare = await run(false);
  assert.deepEqual(bare.lines, ["data -1 -1 0"]);
  assert.equal(
    bare.error,
    "TypeError: Error #2022: Class PlacedData$ must inherit from DisplayObject to link to a symbol.",
  );
});

// The rounds of a frame's scripts: another round runs when a script made
// something else's due, and is left out when nothing a round reads changed
// (display.ts's scriptWork). In version 9, where a goto runs no cycle of
// its own, each way a script can make another clip's script due shows in
// the rounds.
// Clip, of 4 frames, the fourth placing a Kid, each frame's script traced;
// on its second frame, the clip after a, named for what it does, sends a,
// whose script ran, to a frame, or makes a Kid with `new`, and adds it or
// not. Each makes a script due after the round has listed its clips,
// which only another round runs.
const SOURCE = `package {
  import flash.display.MovieClip;

  public dynamic class Clip extends MovieClip {
    public function Clip() {
      addFrameScript(0, function():void { trace(name, 1); },
        1, function():void { trace(name, 2); stop(); if (name != "a") poke(); },
        2, function():void { trace(name, 3); stop(); },
        3, function():void { trace(name, 4); stop(); });
    }

    private function poke():void {
      var a:MovieClip = MovieClip(parent.getChildByName("a"));
      if (name == "goto") {
        a.gotoAndStop(3);
      } else if (name == "place") {
        a.gotoAndStop(4);
      } else {
        var kid:Kid = new Kid();
        kid.name = name;
        if (name == "add") {
          MovieClip(parent).addChild(kid);
        }
      }
    }
  }

  public class Kid extends MovieClip {
    public function Kid() {
      addFrameScript(0, function():void { trace("kid", name); });
    }
  }

  public dynamic class Main extends MovieClip {
    public function Main() {
      addFrameScript(1, function():void { trace("main", 2); stop(); });
    }
  }
}`;

/** A version 9 root of a Clip "a" and one named `second` after it. */
function roundsSwf(abc: Uint8Array, second: string): Uint8Array {
  return w.swf({
    version: 9,
    width: 20,
    height: 20,
    frameCount: 2,
    tags: [
      w.fileAttributes(true),
      w.sprite(3, 1, [w.showFrame(), w.end()]),
      w.sprite(2, 4, [
        w.showFrame(),
        w.showFrame(),
        w.showFrame(),
        w.place({ depth: 1, character: 3, name: "kid" }),
        w.showFrame(),
        w.end(),
      ]),
      w.doAbc(abc),
      w.symbolClass([
        [0, "Main"],
        [2, "Clip"],
        [3, "Kid"],
      ]),
      w.place({ depth: 1, character: 2, name: "a" }),
      w.place({ depth: 2, character: 2, name: second }),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

for (const [second, due] of [
  // A clip's frame moved.
  ["goto", ["a 3"]],
  // That, and a child placed and made alive.
  ["place", ["a 4", "kid kid"]],
  // A clip made alive, with `new`, off the list, and on it.
  ["make", ["kid make"]],
  ["add", ["kid add"]],
] as const) {
  test(`a script that makes another's due has it run in the next round: ${second}`, {
    skip,
  }, async () => {
    const lines: string[] = [];
    const scripting = new Scripting(await createCodegen(wasm), { print: (l) => lines.push(l) });
    await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
    const player = new Player(roundsSwf(compiler(out)("Rounds", SOURCE), second), scripting);
    await player.start();
    assert.deepEqual(lines.splice(0), ["a 1", `${second} 1`]);

    player.tick();
    assert.deepEqual(lines.splice(0), ["main 2", "a 2", `${second} 2`, ...due]);

    player.tick();
    assert.deepEqual(lines, []);
  });
}

test("a frame whose scripts change nothing a round reads takes one round", {
  skip,
}, async () => {
  const source = `package {
    import flash.display.MovieClip;
    public class Quiet extends MovieClip {
      public var n:int = 0;
      public function Quiet() {
        addFrameScript(0, function():void { n++; }, 1, function():void { n++; });
      }
    }
  }`;
  const scripting = new Scripting(await createCodegen(wasm), { print: () => {} });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const abc = compiler(out)("Quiet", source);
  const player = new Player(
    w.swf({
      width: 20,
      height: 20,
      frameCount: 2,
      tags: [
        w.fileAttributes(true),
        w.doAbc(abc),
        w.symbolClass([[0, "Quiet"]]),
        w.showFrame(),
        w.showFrame(),
        w.end(),
      ],
    }),
    scripting,
  );
  await player.start();

  // The root's script runs, and changes nothing a round reads: no second
  // round walks the list. Each walk, the tick's and each round's, starts
  // with the orphans. The checked build runs the round left out anyway, to
  // see that it finds nothing.
  let walks = 0;
  const orphanRoots = scripting.lifecycle.orphanRoots.bind(scripting.lifecycle);
  scripting.lifecycle.orphanRoots = () => {
    walks++;
    return orphanRoots();
  };
  for (let i = 0; i < 4; i++) {
    player.tick();
  }

  assert.equal(walks, Scripting.checkRounds ? 12 : 8);
  const n = scripting.rt.getProperty(
    player.root.object as avm2.AsObject,
    avm2.qname(avm2.publicNs, "n"),
  );
  assert.equal(n, 5);
});

test("destroy closes the open connections, aborts the fetches and closes the audio host", async () => {
  const closed: string[] = [];
  let aborted: AbortSignal | null = null;
  let audioClosed = 0;
  const remote: { close?: () => void; error?: (message: string) => void } = {};
  const scripting = new Scripting(await createCodegen(wasm), {
    socket: {
      connect(host, _port, events) {
        if (host === "peer-closes") {
          remote.close = events.close;
        }

        if (host === "refused") {
          remote.error = events.error;
        }

        return { send: () => {}, close: () => closed.push(`socket ${host}`) };
      },
    },
    webSocket: {
      connect: (url) => ({ send: () => {}, close: () => closed.push(`webSocket ${url}`) }),
    },
    fetch: (_request, signal) => {
      aborted = signal;
      return new Promise(() => {});
    },
    audio: { decode: () => Promise.reject(new Error("no device")), close: () => audioClosed++ },
  });
  const events = { open() {}, data() {}, close() {}, error() {} };
  const wsEvents = { open() {}, message() {}, close() {}, error() {} };
  assert.ok(scripting.socket && scripting.webSocket && scripting.fetch);
  scripting.socket.connect("open", 1, events);
  scripting.socket.connect("closed-here", 1, events).close();
  scripting.socket.connect("peer-closes", 1, events);
  remote.close?.();
  // Refused, with no close after it: nothing left for destroy to close.
  scripting.socket.connect("refused", 1, events);
  remote.error?.("Error #2031: Socket Error.");
  scripting.webSocket.connect("ws://open.test/", [], wsEvents);
  void scripting.fetch(
    { url: "http://a.test/", method: "GET", headers: [], body: null },
    new AbortController().signal,
  );
  assert.deepEqual(closed, ["socket closed-here"]);

  scripting.destroy();
  // Only what neither end had closed, once each, however often destroyed.
  scripting.destroy();
  assert.deepEqual(closed, ["socket closed-here", "socket open", "webSocket ws://open.test/"]);
  assert.equal((aborted as AbortSignal | null)?.aborted, true);
  assert.equal(audioClosed, 1);
  assert.ok(scripting.destroyed);
});
