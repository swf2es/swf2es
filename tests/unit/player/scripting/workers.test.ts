// flash.system's workers through a SWF's scripts: background workers
// started on node worker_threads threads, played against Flash's trace of
// the same cases, and what a player without a worker host reports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
import type { WorkerHost } from "../../../../packages/player/dist/hosts.js";
import { Player } from "../../../../packages/player/dist/player.js";
import { Scripting } from "../../../../packages/player/dist/scripting.js";
import { nodeWorkerHost } from "../../../../packages/player-hosts/dist/node.js";
import { bare, cases } from "../../../player/cases.ts";
import { libraryAbcs } from "../../../player/libraries.ts";
import { compiler } from "../../../player/scripts.ts";

// This file's own out directory: the other test files compile at the same time.
const out = fileURLToPath(new URL("../../out/player-workers/", import.meta.url));

let skip: string | false = false;
try {
  containerEngine();
} catch (e) {
  skip = (e as Error).message;
}

const wasm = await WebAssembly.compile(
  await readFile(fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
);

for (const [name, script, what] of [
  ["worker-basics", "WorkerBasics", "a background worker on a thread of its own answers"],
  [
    "worker-shared-bytes",
    "WorkerSharedBytes",
    "two workers on threads of their own share a ByteArray",
  ],
  [
    "worker-mutex",
    "WorkerMutex",
    "two workers on threads of their own share a Mutex and a Condition",
  ],
]) {
  test(`${what} as Flash's do`, { skip }, async () => {
    const lines: string[] = [];
    const uncaught: unknown[] = [];
    const scripting = new Scripting(await createCodegen(wasm), {
      print: (line) => lines.push(line),
      realTime: null,
      onUncaught: (error) => uncaught.push(error),
      workerHost: nodeWorkerHost({ codegen: wasm }),
    });
    try {
      await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
      const testCase = cases.find((c) => c.name === name);
      assert.ok(testCase && typeof testCase.swf === "function");
      const player = new Player(testCase.swf(compiler(out)(script)), scripting);
      await player.start();
      // As the player's tests step it: what was posted to the worker has been run before each frame.
      for (let frame = 2; frame <= (testCase.frames ?? 1); frame++) {
        await scripting.settled();
        player.tick();
      }

      assert.deepEqual(uncaught, []);
      const expected = await readFile(
        fileURLToPath(new URL(`../../../player/references/${name}/trace.txt`, import.meta.url)),
        "utf8",
      );
      assert.deepEqual(lines, expected.trimEnd().split("\n"));
    } finally {
      scripting.destroy();
    }
  });
}

test("without a worker host no worker is supported, and none is created", { skip }, async () => {
  const lines: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
  });
  await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
  const abc = compiler(out)(
    "Main",
    `package {
  import flash.display.Sprite;
  import flash.system.Worker;
  import flash.system.WorkerDomain;

  public class Main extends Sprite {
    public function Main() {
      trace(Worker.isSupported + " " + WorkerDomain.isSupported + " " + Worker.current.isPrimordial);
      trace(WorkerDomain.current.listWorkers().length + " " + (WorkerDomain.current.listWorkers()[0] == Worker.current));
      Worker.current.setSharedProperty("a", [1]);
      trace(Worker.current.getSharedProperty("a") + " " + Worker.current.state);
      WorkerDomain.current.createWorker(loaderInfo.bytes);
    }
  }
}`,
  );
  const player = new Player(bare(abc, 1), scripting);
  // The player's own error, which no script catches, as for what else it cannot do.
  await assert.rejects(player.start(), {
    message: "swf2es: creating a Worker without a worker host is not supported yet",
  });

  assert.deepEqual(lines, ["false false true", "1 true", "1 running"]);
});

/**
 * Plays a document class whose primordial runs `primordial` and whose
 * background workers run `background`, both bodies of methods of a Sprite
 * that has `n`, `w` and `ch` to keep things in, for `frames` frames stepped
 * as the player's tests step them, or, with `blocking`, a few milliseconds
 * apart, for workers that block in a frame, which settled() would wait for
 * for ever. Its traces, those of its workers mixed in, and its uncaught
 * errors' messages.
 */
async function play(
  name: string,
  primordial: string,
  background: string,
  options: { frames?: number; workerHost?: WorkerHost; blocking?: boolean } = {},
): Promise<{ lines: string[]; uncaught: string[]; scripting: Scripting }> {
  const lines: string[] = [];
  const uncaught: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    // An AS3 error is no JavaScript Error: its own text.
    onUncaught: (error) =>
      uncaught.push(error instanceof Error ? error.message : scripting.rt.toString(error as never)),
    workerHost: options.workerHost ?? nodeWorkerHost({ codegen: wasm }),
  });
  try {
    await scripting.loadLibraries(libraryAbcs(`${out}libraries/`));
    const abc = compiler(out)(
      name,
      `package {
  import flash.display.*;
  import flash.events.*;
  import flash.system.*;
  import flash.utils.*;
  import flash.concurrent.*;

  public class ${name} extends Sprite {
    private var n:int = 0;
    private var w:Worker;
    private var ch:MessageChannel;
    private var back:MessageChannel;

    public function ${name}() {
      if (Worker.current.isPrimordial) {
        primordial();
      } else {
        background();
      }
    }

    private function describe(e:Error):String {
      return getQualifiedClassName(e) + " " + e.errorID;
    }

    private function primordial():void {
${primordial}
    }

    private function background():void {
${background}
    }
  }
}`,
    );
    const swf = bare(abc, 1, name);
    swf[3] = 26;
    const player = new Player(swf, scripting);
    await player.start();
    for (let frame = 2; frame <= (options.frames ?? 40); frame++) {
      if (options.blocking) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      } else {
        await scripting.settled();
      }

      player.tick();
    }

    return { lines, uncaught, scripting };
  } finally {
    scripting.destroy();
  }
}

/** How many background workers the primordial still holds. */
function held(scripting: Scripting): number {
  return (scripting.workers as unknown as { backgrounds: Map<number, unknown> }).backgrounds.size;
}

test("a channel's sender is closed once its receiver has taken what was queued", {
  skip,
}, async () => {
  const { lines, uncaught } = await play(
    "CloseSender",
    `      w = WorkerDomain.current.createWorker(loaderInfo.bytes);
      ch = Worker.current.createMessageChannel(w);
      ch.addEventListener(Event.CHANNEL_STATE, function(e:Event):void {
        trace("state event " + ch.state);
      });
      w.setSharedProperty("ch", ch);
      ch.send("a");
      ch.close();
      trace("after close " + ch.state + " " + ch.messageAvailable);
      w.start();
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        if (++n == 30) {
          trace("frame 30 " + ch.state + " " + ch.messageAvailable);
        }
      });`,
    `      var c:MessageChannel = Worker.current.getSharedProperty("ch");
      trace("background " + c.state + " " + c.messageAvailable + " " + c.receive() + " " + c.state);`,
  );

  assert.deepEqual(uncaught, []);
  assert.deepEqual(lines, [
    "after close closing true",
    "state event closing",
    "background closing true a closed",
    "state event closed",
    "frame 30 closed false",
  ]);
});

test("a channel between two background workers closes on the primordial too", {
  skip,
}, async () => {
  const { lines, uncaught } = await play(
    "CloseBetween",
    `      var a:Worker = WorkerDomain.current.createWorker(loaderInfo.bytes);
      var b:Worker = WorkerDomain.current.createWorker(loaderInfo.bytes);
      ch = a.createMessageChannel(b);
      a.setSharedProperty("role", "a");
      b.setSharedProperty("role", "b");
      a.setSharedProperty("ch", ch);
      b.setSharedProperty("ch", ch);
      a.start();
      b.start();
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        if (++n == 30) {
          trace("primordial " + ch.state);
        }
      });`,
    `      var c:MessageChannel = Worker.current.getSharedProperty("ch");
      if (Worker.current.getSharedProperty("role") == "a") {
        c.send(1);
        c.send(2);
        c.close();
        return;
      }

      c.addEventListener(Event.CHANNEL_MESSAGE, function(e:Event):void {
        trace("b " + c.receive() + " " + c.state);
      });`,
  );

  assert.deepEqual(uncaught, []);
  assert.deepEqual(lines, ["b 1 closing", "b 2 closed", "primordial closed"]);
});

test("a host that cannot start a thread fails start with 3807, and the worker is terminated", {
  skip,
}, async () => {
  const { lines, uncaught, scripting } = await play(
    "HostThrows",
    `      w = WorkerDomain.current.createWorker(loaderInfo.bytes);
      try {
        w.start();
      } catch (e:Error) {
        trace("start " + describe(e));
      }

      trace("state " + w.state + " " + WorkerDomain.current.listWorkers().length);
      try {
        w.start();
      } catch (e:Error) {
        trace("again " + describe(e));
      }`,
    "",
    {
      frames: 3,
      workerHost: {
        start() {
          throw new Error("blocked by the page's policy");
        },
      },
    },
  );

  assert.deepEqual(uncaught, []);
  assert.deepEqual(lines, [
    "start flash.errors::IllegalOperationError 3807",
    "state terminated 1",
    "again flash.errors::IllegalOperationError 1511",
  ]);
  assert.equal(held(scripting), 0);
});

test("a terminated worker is let go, its channels' undelivered messages with it", {
  skip,
}, async () => {
  const { lines, uncaught, scripting } = await play(
    "Churn",
    `      ch = Worker.current.createMessageChannel(Worker.current);
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        if (n < 5) {
          w = WorkerDomain.current.createWorker(loaderInfo.bytes);
          w.addEventListener(Event.WORKER_STATE, function(e:Event):void {
            trace("state " + e.target.state);
          });
          ch = Worker.current.createMessageChannel(w);
          w.start();
          ch.send("x");
          trace("terminate " + w.terminate() + " " + ch.messageAvailable);
        } else if (n == 5) {
          trace("after " + ch.messageAvailable + " " + w.state + " " + WorkerDomain.current.listWorkers().length);
        }

        n++;
      });`,
    "",
    { frames: 10 },
  );

  assert.deepEqual(uncaught, []);
  assert.deepEqual(lines, [
    ...Array.from({ length: 5 }, () => ["terminate true false", "state terminated"]).flat(),
    "after false terminated 1",
  ]);
  assert.equal(held(scripting), 0);
});

test("a background worker that terminates itself is terminated on the primordial", {
  skip,
}, async () => {
  const { lines, uncaught, scripting } = await play(
    "SelfTerminate",
    `      w = WorkerDomain.current.createWorker(loaderInfo.bytes);
      w.start();
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        if (++n == 20) {
          trace("primordial " + w.state + " " + WorkerDomain.current.listWorkers().length);
        }
      });`,
    "      Worker.current.terminate();",
  );

  assert.deepEqual(uncaught, []);
  assert.deepEqual(lines, ["primordial terminated 1"]);
  assert.equal(held(scripting), 0);
});

test("a channel's queue is seen at once at both ends, and receive(true) blocks for a message", {
  skip,
}, async () => {
  const { lines, uncaught } = await play(
    "Blocking",
    `      w = WorkerDomain.current.createWorker(loaderInfo.bytes);
      ch = Worker.current.createMessageChannel(w);
      back = w.createMessageChannel(Worker.current);
      w.setSharedProperty("ch", ch);
      w.setSharedProperty("back", back);
      ch.send("a");
      ch.send("b");
      trace("queued " + ch.messageAvailable);
      w.start();
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        if (++n == 3) {
          trace("received " + back.receive(true));
          trace("the sender sees " + ch.messageAvailable);
          ch.send("c");
          trace("then " + back.receive(true));
          ch.close();
          trace("closed " + back.receive(true));
        }
      });`,
    `      ch = Worker.current.getSharedProperty("ch");
      back = Worker.current.getSharedProperty("back");
      back.send(ch.receive() + ch.receive() + " " + ch.messageAvailable);
      back.send(ch.receive(true));
      try {
        ch.receive(true);
      } catch (e:Error) {
        back.send(describe(e));
      }`,
    { frames: 6, blocking: true },
  );

  assert.deepEqual(uncaught, []);
  assert.deepEqual(lines, [
    "queued true",
    "received ab false",
    "the sender sees false",
    "then c",
    "closed flash.errors::IOError 3738",
  ]);
});

test("a Mutex and a Condition cross to a worker by reference, and block across threads", {
  skip,
}, async () => {
  const { lines, uncaught } = await play(
    "Locks",
    `      var m:Mutex = new Mutex();
      var c:Condition = new Condition(m);
      var ws:Array = [];
      for (var i:int = 0; i < 2; i++) {
        ws[i] = WorkerDomain.current.createWorker(loaderInfo.bytes);
        ws[i].setSharedProperty("m", m);
        ws[i].setSharedProperty("c", c);
        ws[i].setSharedProperty("role", i);
        ws[i].setSharedProperty("back", ws[i].createMessageChannel(Worker.current));
      }

      trace("same " + (ws[0].getSharedProperty("m") === m) + " " + (ws[0].getSharedProperty("c") === c));
      ws[0].start();
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        if (++n == 3) {
          back = ws[0].getSharedProperty("back");
          trace(back.receive(true));
          // Taken only once the worker waits, which lets go of it.
          m.lock();
          c.notify();
          trace("notified");
          m.unlock();
          trace(back.receive(true));

          ws[1].start();
          back = ws[1].getSharedProperty("back");
          trace(back.receive(true));
          trace("held by a worker " + m.tryLock());
          ws[1].terminate();
          // Let go once its thread stops, at its blocked receive.
          var nap:Condition = new Condition(new Mutex());
          nap.mutex.lock();
          var start:int = getTimer();
          var got:Boolean = false;
          while (!(got = m.tryLock()) && getTimer() - start < 10000) {
            nap.wait(1);
          }

          trace("after terminate " + got);
          trace("waited " + c.wait(5));
          m.unlock();
        }
      });`,
    `      var m:Mutex = Worker.current.getSharedProperty("m");
      var c:Condition = Worker.current.getSharedProperty("c");
      back = Worker.current.getSharedProperty("back");
      m.lock();
      if (Worker.current.getSharedProperty("role") == 0) {
        back.send("locked " + (c.mutex === m) + " " + (Worker.current.getSharedProperty("m") === m));
        var r:Boolean = c.wait();
        back.send("woke " + r + " " + m.tryLock());
        m.unlock();
        m.unlock();
      } else {
        back.send("holding");
        new Condition(new Mutex()).mutex.lock();
        Worker.current.createMessageChannel(Worker.current).receive(true);
      }`,
    { frames: 6, blocking: true },
  );

  assert.deepEqual(uncaught, []);
  assert.deepEqual(lines, [
    "same true true",
    "locked true true",
    "notified",
    "woke false true",
    "holding",
    "held by a worker false",
    "after terminate true",
    "waited true",
  ]);
});

test("a shared property set by a worker is seen at once by a primordial that waits for it", {
  skip,
}, async () => {
  const { lines, uncaught } = await play(
    "SeenAtOnce",
    `      w = WorkerDomain.current.createWorker(loaderInfo.bytes);
      w.start();
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        if (++n == 3) {
          // Never back in its event loop until it sees it.
          var nap:Condition = new Condition(new Mutex());
          nap.mutex.lock();
          var start:int = getTimer();
          while (w.getSharedProperty("answer") === undefined && getTimer() - start < 10000) {
            nap.wait(1);
          }

          trace("answer " + w.getSharedProperty("answer"));
          Worker.current.setSharedProperty("question", "asked");
          start = getTimer();
          while (w.getSharedProperty("echo") === undefined && getTimer() - start < 10000) {
            nap.wait(1);
          }

          trace("echo " + w.getSharedProperty("echo"));
        }
      });`,
    `      Worker.current.setSharedProperty("answer", 42);
      var nap:Condition = new Condition(new Mutex());
      nap.mutex.lock();
      var primordial:Worker = WorkerDomain.current.listWorkers()[0];
      while (primordial.getSharedProperty("question") === undefined) {
        nap.wait(1);
      }

      Worker.current.setSharedProperty("echo", primordial.getSharedProperty("question"));`,
    { frames: 6, blocking: true },
  );

  assert.deepEqual(uncaught, []);
  assert.deepEqual(lines, ["answer 42", "echo asked"]);
});

test("a background worker makes and starts a worker, even while the primordial waits for it", {
  skip,
}, async () => {
  const { lines, uncaught } = await play(
    "Nested",
    `      w = WorkerDomain.current.createWorker(loaderInfo.bytes);
      w.setSharedProperty("role", "maker");
      w.start();
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        if (++n == 3) {
          var nap:Condition = new Condition(new Mutex());
          nap.mutex.lock();
          var start:int = getTimer();
          while (w.getSharedProperty("made") === undefined && getTimer() - start < 10000) {
            nap.wait(1);
          }

          trace("made " + w.getSharedProperty("made"));
        }
      });`,
    `      if (Worker.current.getSharedProperty("role") == "maker") {
        var child:Worker = WorkerDomain.current.createWorker(loaderInfo.bytes);
        trace("child " + child.state + " " + child.isPrimordial);
        child.setSharedProperty("role", "child");
        var m:Mutex = new Mutex();
        var c:Condition = new Condition(m);
        child.setSharedProperty("c", c);
        m.lock();
        child.start();
        // The child notifies once it runs, holding the mutex.
        var notified:Boolean = !c.wait(10000);
        m.unlock();
        Worker.current.setSharedProperty("made", notified + " " + child.getSharedProperty("hello") + " " + child.state);
      } else {
        var cc:Condition = Worker.current.getSharedProperty("c");
        Worker.current.setSharedProperty("hello", "hi");
        cc.mutex.lock();
        cc.notify();
        cc.mutex.unlock();
      }`,
    { frames: 6, blocking: true },
  );

  assert.deepEqual(uncaught, []);
  // The child's trace comes once the primordial is back in its event loop.
  assert.deepEqual(lines, ["made true hi running", "child new false"]);
});

test("a Mutex a terminated worker held is free to take only once its thread has stopped", {
  skip,
}, async () => {
  const { lines, uncaught } = await play(
    "KilledHolder",
    `      var m:Mutex = new Mutex();
      var log:ByteArray = new ByteArray();
      log.shareable = true;
      log.length = 16;
      w = WorkerDomain.current.createWorker(loaderInfo.bytes);
      w.setSharedProperty("role", "maker");
      w.setSharedProperty("m", m);
      w.setSharedProperty("log", log);
      w.start();
      var got:Boolean = false;
      var seen:int = -1;
      addEventListener(Event.ENTER_FRAME, function(e:Event):void {
        if (log[3] != 1 || seen == -2) {
          return;
        }

        if (seen == -1) {
          trace("held right after terminate " + (log[4] == 0));
          seen = -3;
        }

        // Taken once the child's thread has stopped, and nothing writes after.
        if (got) {
          trace("written after it was taken " + (log[1] != seen));
          seen = -2;
          m.unlock();
        } else if (m.tryLock()) {
          got = true;
          seen = log[1];
          trace("taken");
        }
      });`,
    `      var m:Mutex = Worker.current.getSharedProperty("m");
      var log:ByteArray = Worker.current.getSharedProperty("log");
      if (Worker.current.getSharedProperty("role") == "maker") {
        var child:Worker = WorkerDomain.current.createWorker(loaderInfo.bytes);
        child.setSharedProperty("role", "child");
        child.setSharedProperty("m", m);
        child.setSharedProperty("log", log);
        child.start();
        var nap:Condition = new Condition(new Mutex());
        nap.mutex.lock();
        while (log[0] != 1) {
          nap.wait(1);
        }

        child.terminate();
        // Its thread has not stopped yet, and still writes.
        log[4] = m.tryLock() ? 1 : 0;
        log[3] = 1;
      } else {
        m.lock();
        log[0] = 1;
        for (;;) {
          log[1] = (log[1] + 1) & 255;
        }
      }`,
    { frames: 150, blocking: true },
  );

  assert.deepEqual(uncaught, []);
  assert.deepEqual(lines, [
    "held right after terminate true",
    "taken",
    "written after it was taken false",
  ]);
});
