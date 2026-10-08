// The player's clock and timers through a SWF's scripts: Timer's firings
// in the order of their times, and getTimer by the real clock or the
// frame's.
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
const out = fileURLToPath(new URL("../../out/player-timers/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

test("timers fire in the order of their times, each at its own time", { skip }, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    // The frame clock: what the timers trace of getTimer is the same on every run.
    realTime: null,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  // A 10 fps root: the clock is at 100 as the constructor starts the timers, at 400 after three ticks.
  const player = new Player(bare(compiler(out)("Timers"), 4), scripting);
  player.frameRate = 10;
  await player.start();
  player.tick();
  player.tick();
  player.tick();
  // Both due at 400: B was scheduled for it first, at 250, and goes first.
  assert.deepEqual(lines, ["A 200", "B 250", "A 300", "B 400", "A 400"]);
});

test("timers due at once fire in the order started, after others around them were stopped", {
  skip,
}, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    // The frame clock: what the timers trace of getTimer is the same on every run.
    realTime: null,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  // Five timers started A to E, three stopped at once: B and C, both due at 300, keep their order.
  const player = new Player(bare(compiler(out)("TimerTies"), 3), scripting);
  player.frameRate = 10;
  await player.start();
  player.tick();
  player.tick();
  assert.deepEqual(lines, ["B 300", "C 300"]);
});

test("a timer whose closure throws keeps running and fires again", { skip }, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    // The frame clock: what the timers trace of getTimer is the same on every run.
    realTime: null,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(bare(compiler(out)("TimerThrows"), 3), scripting);
  player.frameRate = 10;
  await player.start();
  // The first firing's error reaches the host; the timer is back in its place for the next.
  assert.throws(() => player.tick());
  assert.equal(scripting.timers.now, scripting.timers.clock);
  player.tick();
  assert.deepEqual(lines, ["firing 1 200 true", "firing 2 300 true"]);
});

test("getTimer reads the real clock as it runs on within a frame, or the frame clock if asked", {
  skip,
}, async () => {
  const compile = compiler(out);
  const swf = bare(
    compile(
      "ClockReads",
      `package {
        import flash.display.Sprite;
        import flash.utils.getTimer;
        public class ClockReads extends Sprite {
          public function ClockReads() { var a:int = getTimer(); var b:int = getTimer(); trace(a, b); }
        }
      }`,
    ),
    1,
    "ClockReads",
  );

  // The frame clock: the first frame's time at 24 fps, the same at each read.
  const framed: string[] = [];
  const stepped = new Scripting(await createCodegen(wasm), {
    print: (l) => framed.push(l),
    realTime: null,
  });
  await stepped.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(swf, stepped).start();
  assert.deepEqual(framed, ["42 42"]);

  // A host's clock, read once as the player starts, then at each getTimer:
  // the time since, which runs on within the frame.
  let clock = 1000;
  const real: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (l) => real.push(l),
    realTime: () => (clock += 2),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(swf, scripting).start();
  assert.deepEqual(real, ["2 4"]);
});

test("getTimer runs on in real time by default", { skip }, async () => {
  const swf = bare(
    compiler(out)(
      "ClockRuns",
      `package {
        import flash.display.Sprite;
        import flash.utils.getTimer;
        public class ClockRuns extends Sprite {
          public function ClockRuns() {
            var start:int = getTimer();
            for (var n:int = 0; getTimer() == start && n < 100000000; n++) {}
            trace(getTimer() > start);
          }
        }
      }`,
    ),
    1,
    "ClockRuns",
  );
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), { print: (l) => lines.push(l) });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  await new Player(swf, scripting).start();
  assert.deepEqual(lines, ["true"]);
});

/**
 * A SWF that logs, between one ENTER_FRAME and the next, the frame's
 * events and each timer's firings with getTimer: b and a every 10 ms,
 * started in that order, c every 30 ms, shorter than a 24 fps frame, and d
 * every 50 ms, longer. Each ENTER_FRAME traces the log so far.
 */
const paceSource = `package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.TimerEvent;
  import flash.utils.Timer;
  import flash.utils.getTimer;
  public class TimerPace extends Sprite {
    private var log:Array = [];
    public function TimerPace() {
      start("b", 10);
      start("a", 10);
      start("c", 30);
      start("d", 50);
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        trace(log.join(" "));
        log = ["EF" + getTimer()];
      });
      addEventListener(Event.FRAME_CONSTRUCTED, function(e:Event):void { log.push("FC"); });
    }
    private function start(name:String, delay:int):void {
      var t:Timer = new Timer(delay);
      t.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void { log.push(name + getTimer()); });
      t.start();
    }
  }
}`;

/** TimerPace's traces on a host whose clock moves by each of `dts` before the advance() it passes it to. */
async function pace(dts: number[], realTime: boolean): Promise<string[][]> {
  const lines: string[] = [];
  let now = 0;
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: realTime ? () => now : null,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const swf = bare(compiler(out)("TimerPace", paceSource), 1, "TimerPace");
  const player = new Player(swf, scripting);
  await player.start();
  for (const dt of dts) {
    now += dt;
    player.advance(dt);
  }

  // The first trace is the frame before the first ENTER_FRAME's.
  return lines.slice(1).map((line) => line.split(" "));
}

const hz60 = (calls: number) => Array.from({ length: calls }, () => 1000 / 60);
const fires = (frame: string[], name: string) => frame.filter((e) => e[0] === name).length;

test("by the real clock, a timer shorter than a frame fires at each check, 2 or 3 times a 24 fps frame at 60 Hz", {
  skip,
}, async () => {
  const frames = await pace(hz60(120), true);

  assert.ok(frames.length >= 45, `${frames.length} frames`);
  for (const frame of frames.slice(2)) {
    // Once a call: a 10 ms timer as often as a 60 Hz host checks, as adl's 2 to 4 a frame.
    assert.ok([2, 3].includes(fires(frame, "a")), frame.join(" "));
    assert.equal(fires(frame, "a"), fires(frame, "b"), frame.join(" "));
  }
});

test("by the real clock, the frame's timers fire after ENTER_FRAME, before the frame is constructed, in the order started", {
  skip,
}, async () => {
  const frames = await pace(hz60(120), true);

  for (const frame of frames) {
    const fc = frame.indexOf("FC");
    const time = frame[0].slice(2);
    assert.ok(frame[0].startsWith("EF") && fc > 0, frame.join(" "));
    // Those in the frame's pass fire at its time, b before a as started.
    for (const event of frame.slice(1, fc)) {
      assert.equal(event.slice(1), time, frame.join(" "));
    }

    const pass = frame.slice(1, fc).map((e) => e[0]);
    assert.deepEqual(
      pass,
      ["b", "a", "c", "d"].filter((n) => pass.includes(n)),
      frame.join(" "),
    );
  }
});

test("by the real clock, a timer as long as a frame or longer fires only in a frame, one shorter between frames too", {
  skip,
}, async () => {
  const frames = await pace(hz60(240), true);
  const between = (name: string) =>
    frames.flatMap((frame) => frame.slice(frame.indexOf("FC") + 1)).filter((e) => e[0] === name);

  // 50 ms at 24 fps: every other frame, as adl fires a 45, 50 or 60 ms timer.
  assert.equal(between("d").length, 0);
  const d = frames.map((frame) => fires(frame, "d"));
  assert.ok(Math.abs(d.reduce((a, b) => a + b, 0) - frames.length / 2) <= 1, d.join(""));
  // 30 ms: between frames as well.
  assert.ok(between("c").length > 0);
});

test("by the real clock, a long frame fires each timer once and drops the ticks it lost", {
  skip,
}, async () => {
  const frames = await pace([...hz60(30), 200, ...hz60(30)], true);
  // The frame the 200 ms call plays, whose pass is the only check in those 200 ms.
  const at = (frame: string[]) => Number(frame[0].slice(2));
  const long = frames.find((frame, i) => i > 0 && at(frame) - at(frames[i - 1]) > 150);
  assert.ok(long, frames.map((f) => f[0]).join(" "));
  const i = frames.indexOf(long);
  const before = frames[i - 1];

  // 200 ms of a 10 ms timer's ticks: none between the frames, one firing each at the frame's time.
  assert.deepEqual(before.slice(before.indexOf("FC") + 1), []);
  assert.deepEqual(
    long.slice(1, long.indexOf("FC")).filter((e) => e[0] === "a" || e[0] === "b"),
    [`b${long[0].slice(2)}`, `a${long[0].slice(2)}`],
  );

  // Then the usual pace again.
  for (const frame of frames.slice(i + 1)) {
    assert.ok(fires(frame, "a") <= 3, frame.join(" "));
  }
});

test("by the frame clock, every due time in the frame fires after its ENTER_FRAME, none between frames", {
  skip,
}, async () => {
  const frames = await pace(hz60(60), false);

  for (const frame of frames.slice(1, -1)) {
    const fc = frame.indexOf("FC");
    // A 10 ms timer at each of its times in a 41.7 ms frame, all before the frame's construction.
    assert.equal(fc, frame.length - 1, frame.join(" "));
    assert.ok([4, 5].includes(fires(frame, "a")), frame.join(" "));
    assert.equal(
      new Set(frame.filter((e) => e[0] === "a")).size,
      fires(frame, "a"),
      frame.join(" "),
    );
  }
});

/** A SWF at `fps` with a timer of each of `delays`, which traces at each ENTER_FRAME the frames so far and each timer's firings. */
function rateSwf(fps: number, delays: string[]): Uint8Array {
  const name = `TimerRate${fps}_${delays.length}_${delays.join("_").replace(/[^0-9]/g, "")}`;
  return bare(
    compiler(out)(
      name,
      `package {
        import flash.display.Sprite;
        import flash.events.Event;
        import flash.events.TimerEvent;
        import flash.utils.Timer;
        public class ${name} extends Sprite {
          private var fires:Array = [];
          private var frames:int = 0;
          public function ${name}() {
            stage.frameRate = ${fps};
            var delays:Array = [${delays.join(", ")}];
            for (var i:int = 0; i < delays.length; i++) {
              fires.push(0);
              var t:Timer = new Timer(delays[i]);
              t.addEventListener(TimerEvent.TIMER, counter(i));
              t.start();
            }
            addEventListener(Event.ENTER_FRAME, function(e:Event):void {
              frames++;
              trace(frames + " " + fires.join(" "));
            });
          }
          private function counter(i:int):Function {
            return function(e:TimerEvent):void { fires[i]++; };
          }
        }
      }`,
    ),
    1,
    name,
  );
}

/**
 * The frames played and each timer's firings from the 20th frame to the
 * last, a host calling advance() with each of `dts` and its clock moved
 * by `clock(dt)`, the injected clock answering `read()` of its time.
 */
async function rates(
  swf: Uint8Array,
  dts: number[],
  read: (now: number, reads: number) => number = (now) => now,
): Promise<{ frames: number; fires: number[] }> {
  const lines: string[] = [];
  let now = 0;
  let reads = 0;
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: () => read(now, reads++),
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const player = new Player(swf, scripting);
  await player.start();
  for (const dt of dts) {
    now += dt;
    player.advance(dt);
  }

  const counts = (line: string) => line.split(" ").map(Number);
  const first = counts(lines[20]);
  const last = counts(lines[lines.length - 1]);
  return { frames: last[0] - first[0], fires: last.slice(1).map((n, i) => n - first[i + 1]) };
}

/** `calls` host intervals around `ms`, each off by up to `jitter` ms, the same on every run. */
function jittered(ms: number, calls: number, jitter: number): number[] {
  let seed = 1;
  return Array.from({ length: calls }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return ms + (seed / 2147483648 - 0.5) * 2 * jitter;
  });
}

test("by the real clock, a timer of the frame's length fires every frame, however the host's calls fall on its grid", {
  skip,
}, async () => {
  // adl, five seconds each: Timer(40) at 25 fps fired 106 times in 125
  // frames, Timer(1000 / 30) (33 ms) 150 in 150, Timer(1000 / 60) (16 ms)
  // 287 in 300. A 25 fps SWF's frames are 33 and 50 ms apart at 60 Hz.
  for (const [fps, delay] of [
    [25, "40"],
    [30, "1000 / 30"],
    [20, "50"],
    [24, "1000 / 24"],
  ] as const) {
    const swf = rateSwf(fps, [delay]);
    for (const dts of [hz60(600), jittered(1000 / 60, 600, 0.4)]) {
      const { frames, fires } = await rates(swf, dts);
      assert.ok(frames > 100, `${fps} fps: ${frames} frames`);
      assert.ok(Math.abs(fires[0] - frames) <= 1, `${fps} fps, ${delay}: ${fires[0]} in ${frames}`);
    }
  }
});

test("by the real clock, a timer a little longer than the frame fires every other frame or so, as in adl", {
  skip,
}, async () => {
  // adl at 24 fps: Timer(42) 78 times in 120 frames, Timer(46) 60.
  const { frames, fires } = await rates(rateSwf(24, ["42", "46"]), jittered(1000 / 60, 600, 0.4));

  for (const n of fires) {
    assert.ok(n >= frames * 0.45 && n <= frames * 0.7, `${fires} in ${frames}`);
  }
});

test("by the real clock, a SWF faster than the display fires its frames' timers in each of them", {
  skip,
}, async () => {
  // 60 fps on a 30 Hz host: two frames a call, each with its own time.
  const { frames, fires } = await rates(
    rateSwf(60, ["16", "1000 / 60"]),
    hz60(300).map((dt) => dt * 2),
  );

  assert.ok(frames > 200, `${frames} frames`);
  for (const n of fires) {
    assert.ok(Math.abs(n - frames) <= 1, `${fires} in ${frames}`);
  }
});

test("by the real clock, a clock that reads NaN now and then neither fires every timer nor stops them", {
  skip,
}, async () => {
  const swf = rateSwf(24, ["10", "100"]);
  const clean = await rates(swf, hz60(300));
  const broken = await rates(swf, hz60(300), (now, reads) => (reads % 3 === 2 ? Number.NaN : now));

  assert.deepEqual(broken, clean);
});

test("by the real clock, a timer stopped, reset or started anew within a pass", {
  skip,
}, async () => {
  const lines: string[] = [];
  let now = 0;
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: () => now,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const swf = bare(
    compiler(out)(
      "TimerRestarts",
      `package {
        import flash.display.Sprite;
        import flash.events.TimerEvent;
        import flash.utils.Timer;
        import flash.utils.getTimer;
        public class TimerRestarts extends Sprite {
          public function TimerRestarts() {
            var a:Timer = new Timer(20);
            var b:Timer = new Timer(20);
            var c:Timer = new Timer(20, 3);
            var n:int = 0;
            a.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void {
              n++;
              trace("a", getTimer(), n);
              if (n == 2) { b.stop(); }
              if (n == 4) { b.start(); }
              if (n == 5) { a.reset(); a.start(); }
            });
            b.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void { trace("b", getTimer()); });
            c.addEventListener(TimerEvent.TIMER, function(e:TimerEvent):void { trace("c", getTimer(), c.currentCount); });
            c.addEventListener(TimerEvent.TIMER_COMPLETE, function(e:TimerEvent):void { trace("c done", getTimer()); });
            a.start();
            b.start();
            c.start();
          }
        }
      }`,
    ),
    1,
    "TimerRestarts",
  );
  const player = new Player(swf, scripting);
  await player.start();
  for (let call = 0; call < 24; call++) {
    now += 1000 / 60;
    player.advance(1000 / 60);
  }

  // 24 fps at 60 Hz, a check each 16.7 ms: a 20 ms timer fires every other
  // check. b, stopped by a in the pass at 66 before its turn, does not fire
  // in it; started anew at 133, it fires 20 ms on, at the next check after
  // 153; a, reset and started at 150, fires again from 170. c completes
  // after its third. Due together at 233, b goes first: a was started after it.
  assert.deepEqual(lines.slice(0, 16), [
    "a 33 1",
    "b 33",
    "c 33 1",
    "a 66 2",
    "c 66 2",
    "a 100 3",
    "c 100 3",
    "c done 100",
    "a 133 4",
    "a 150 5",
    "b 166",
    "a 183 6",
    "b 199",
    "a 216 7",
    "b 233",
    "a 233 8",
  ]);
});
