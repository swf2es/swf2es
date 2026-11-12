// Errors nothing catches: the UncaughtErrorEvent a SWF's listeners hear, the
// way it goes from a loaded SWF's LoaderInfo up through its Loader, and the
// host's report, which is the default a listener prevents. What Flash does
// is the player case "uncaught-errors"; here, what the host is told.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { bare } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../out/player-uncaught/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

/**
 * A document class `name` whose `body` is its members, run for `frames`
 * frames; `inner`, a SWF, is what it loads from any URL. The lines it
 * traced and the errors the host was told of, as their strings.
 */
async function play(
  name: string,
  body: string,
  frames: number,
  { inner, lazyCompilation = false }: { inner?: Uint8Array; lazyCompilation?: boolean } = {},
): Promise<{ lines: string[]; told: string[]; scripting: Scripting; raw: unknown[] }> {
  const lines: string[] = [];
  const raw: unknown[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    onUncaught: (error) => raw.push(error),
    url: "http://example.test/main.swf",
    realTime: null,
    lazyCompilation,
    fetch: async () =>
      inner
        ? { bytes: inner, status: 200, headers: [] }
        : { bytes: null, status: 404, headers: [] },
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compiler(out)(name, source(name, body)), frames, name), scripting);
  await player.start();
  for (let i = 1; i < frames; i++) {
    await scripting.settled();
    player.tick();
  }

  const told = raw.map((error) => scripting.rt.toString(error as never));
  player.destroy();
  return { lines, told, scripting, raw };
}

const source = (name: string, body: string) => `package {
  import flash.display.*;
  import flash.events.*;
  import flash.net.*;
  import flash.utils.*;
  public class ${name} extends MovieClip {
    ${body}
  }
}`;

test("an uncaught error is the host's to report unless a listener prevents it", {
  skip,
}, async () => {
  const { lines, told } = await play(
    "Prevents",
    `private var frame:int = 1;
    public function Prevents() {
      addEventListener(Event.ENTER_FRAME, function (e:Event):void {
        frame++;
        if (frame == 3) {
          loaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR, heard);
        }
        throw new Error("in frame " + frame);
      });
      addEventListener(Event.ENTER_FRAME, function (e:Event):void { trace("frame " + frame + " goes on"); });
    }
    private function heard(e:UncaughtErrorEvent):void {
      trace("heard " + e.error.message);
      if (frame == 4) {
        e.preventDefault();
      }
    }`,
    4,
  );

  assert.deepEqual(lines, [
    "frame 2 goes on",
    "heard in frame 3",
    "frame 3 goes on",
    "heard in frame 4",
    "frame 4 goes on",
  ]);
  // None listened; one did and let it be; one prevented it.
  assert.deepEqual(told, ["Error: in frame 2", "Error: in frame 3"]);
});

test("an ErrorEvent no listener hears is told as Flash words it, or prevented", {
  skip,
}, async () => {
  const { lines, told } = await play(
    "Unheard",
    `public function Unheard() {
      var d:EventDispatcher = new EventDispatcher();
      trace(d.dispatchEvent(new IOErrorEvent(IOErrorEvent.IO_ERROR, false, false, "lost", 7)));
      loaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,
        function (e:UncaughtErrorEvent):void {
          trace(e.error is SecurityErrorEvent, e.error.text, e.error.target);
          e.preventDefault();
        });
      trace(d.dispatchEvent(new SecurityErrorEvent(SecurityErrorEvent.SECURITY_ERROR, false, false, "kept")));
      d.addEventListener(IOErrorEvent.IO_ERROR, function (e:Event):void { trace("heard", e.target == d); });
      trace(d.dispatchEvent(new IOErrorEvent(IOErrorEvent.IO_ERROR, false, false, "heard", 7)));
    }`,
    1,
  );

  assert.deepEqual(lines, ["true", "true kept null", "true", "heard true", "true"]);
  assert.deepEqual(told, ["Error: Error #2044: Unhandled ioError:. text=lost"]);
});

test("a load's IOErrorEvent no listener hears is an uncaught error", { skip }, async () => {
  const { lines, told } = await play(
    "UnheardLoad",
    `private var frame:int = 1;
    public function UnheardLoad() {
      new URLLoader().load(new URLRequest("first.txt"));
      addEventListener(Event.ENTER_FRAME, function (e:Event):void {
        if (++frame != 4) {
          return;
        }

        loaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,
          function (e:UncaughtErrorEvent):void {
            trace(e.error is IOErrorEvent, e.target == loaderInfo);
            e.preventDefault();
          });
        new URLLoader().load(new URLRequest("second.txt"));
      });
    }`,
    6,
  );

  assert.deepEqual(lines, ["true true"]);
  assert.equal(told.length, 1);
  assert.match(told[0], /^Error: Error #2044: Unhandled ioError:\. text=Error #2032/);
});

test("an error of the player's own is the host's alone", { skip }, async () => {
  const { lines, raw, scripting } = await play(
    "Own",
    `public function Own() {
      loaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,
        function (e:UncaughtErrorEvent):void { trace("heard"); e.preventDefault(); });
    }`,
    1,
  );
  const own = new Error("swf2es: not a SWF's error");
  scripting.reportUncaught(own);
  // What is not supported, too, though a script's own catch would get it.
  const unsupported = scripting.rt.unsupported("a thing");
  scripting.reportUncaught(unsupported);

  assert.deepEqual(lines, []);
  assert.deepEqual(raw, [own, unsupported]);
});

test("what a listener of the event throws is dropped, and the error is still told once", {
  skip,
}, async () => {
  const { lines, told } = await play(
    "ListenerThrows",
    `public function ListenerThrows() {
      loaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,
        function (e:UncaughtErrorEvent):void { trace("first"); throw new Error("the listener's"); });
      loaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,
        function (e:UncaughtErrorEvent):void { trace("second"); });
      throw new Error("the constructor's");
    }`,
    1,
  );

  assert.deepEqual(lines, ["first", "second"]);
  assert.deepEqual(told, ["Error: the constructor's"]);
});

test("without a hook, the frame throws what no listener prevented", { skip }, async () => {
  const scripting = new Scripting(await createCodegen(wasm), { print: () => {}, realTime: null });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const swf = bare(
    compiler(out)(
      "FrameThrows",
      source(
        "FrameThrows",
        `private var frame:int = 1;
        public function FrameThrows() {
          loaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,
            function (e:UncaughtErrorEvent):void { if (frame == 3) { e.preventDefault(); } });
          addEventListener(Event.ENTER_FRAME, function (e:Event):void { frame++; throw new Error("frame " + frame); });
        }`,
      ),
    ),
    3,
    "FrameThrows",
  );
  const player = new Player(swf, scripting);
  await player.start();

  assert.throws(
    () => player.tick(),
    (error) => scripting.rt.toString(error as never) === "Error: frame 2",
  );
  player.tick();
});

for (const lazyCompilation of [false, true]) {
  test(`a loaded SWF's error goes from its LoaderInfo up through its Loader (${lazyCompilation ? "lazy" : "eager"})`, {
    skip,
  }, async () => {
    const compile = compiler(out);
    const inner = bare(
      compile(
        "Inner",
        source(
          "Inner",
          `public function Inner() {
            loaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR,
              function (e:UncaughtErrorEvent):void { trace("  inner, phase " + e.eventPhase + ", " + (e.target == loaderInfo)); });
          }
          /** In its own enterFrame listener: \`f\` called, or \`value\` thrown. */
          public function later(value:*, f:Function = null):void {
            var self:MovieClip = this;
            addEventListener(Event.ENTER_FRAME, function (e:Event):void {
              self.removeEventListener(Event.ENTER_FRAME, arguments.callee);
              if (f != null) { f(); } else { throw value; }
            });
          }
          public function fail():void { throw new Error("inner's method"); }`,
        ),
      ),
      2,
      "Inner",
    );
    const { lines, told } = await play(
      "Outer",
      `private var loader:Loader = new Loader();
      private var frame:int = 1;
      private var stop:String = "";
      public function Outer() {
        listen(loaderInfo.uncaughtErrorEvents, "outer");
        listen(loader.uncaughtErrorEvents, "loader");
        loader.load(new URLRequest("inner.swf"));
        addEventListener(Event.ENTER_FRAME, function (e:Event):void {
          var inner:Object = loader.content;
          // Every other frame: what the inner SWF is asked for, it does in its next enterFrame.
          if (++frame % 2) {
            return;
          }

          stop = "";
          switch (frame / 2) {
            case 2: trace("off the list"); inner.later("a string"); break;
            case 3: trace("on the list"); addChild(loader); inner.later(new Error("inner's")); break;
            case 4: trace("stopped at the loader"); stop = "loader"; inner.later(1); break;
            case 5: trace("outer's function"); inner.later(null, function ():void { throw new Error("outer's function"); }); break;
            case 6: trace("inner's method"); inner.fail(); break;
            case 7: trace("not prevented"); stop = "none"; inner.later(2); break;
          }
        });
      }
      private function listen(events:EventDispatcher, name:String):void {
        events.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR, function (e:UncaughtErrorEvent):void {
          trace("  " + name + " capturing, " + (e.currentTarget == (name == "loader" ? loader : loaderInfo)));
        }, true);
        events.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR, function (e:UncaughtErrorEvent):void {
          trace("  " + name + ", phase " + e.eventPhase + ", " + (e.target == loader.contentLoaderInfo) + ", " + e.error);
          if (stop != "none") { e.preventDefault(); }
          if (stop == name) { e.stopPropagation(); }
        });
      }`,
      16,
      { inner, lazyCompilation },
    );

    assert.deepEqual(lines, [
      "off the list",
      "  loader capturing, true",
      "  inner, phase 2, true",
      "  loader, phase 3, true, a string",
      "on the list",
      "  outer capturing, true",
      "  loader capturing, true",
      "  inner, phase 2, true",
      "  loader, phase 3, true, Error: inner's",
      "  outer, phase 3, true, Error: inner's",
      "stopped at the loader",
      "  outer capturing, true",
      "  loader capturing, true",
      "  inner, phase 2, true",
      "  loader, phase 3, true, 1",
      // The SWF whose listener the player called, not the one whose function threw.
      "outer's function",
      "  outer capturing, true",
      "  loader capturing, true",
      "  inner, phase 2, true",
      "  loader, phase 3, true, Error: outer's function",
      "  outer, phase 3, true, Error: outer's function",
      "inner's method",
      "  outer, phase 2, false, Error: inner's method",
      "not prevented",
      "  outer capturing, true",
      "  loader capturing, true",
      "  inner, phase 2, true",
      "  loader, phase 3, true, 2",
      "  outer, phase 3, true, 2",
    ]);
    assert.deepEqual(told, ["2"]);
  });
}
