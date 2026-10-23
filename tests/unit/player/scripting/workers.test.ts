// flash.system's workers through a SWF's scripts: a background worker
// started on a node worker_threads thread, played against Flash's trace of
// the same case, and what a player without a worker host reports.
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

test("a background worker on a thread of its own answers as Flash's does", { skip }, async () => {
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
    const testCase = cases.find((c) => c.name === "worker-basics");
    assert.ok(testCase && typeof testCase.swf === "function");
    const player = new Player(testCase.swf(compiler(out)("WorkerBasics")), scripting);
    await player.start();
    // As the player's tests step it: what was posted to the worker has been run before each frame.
    for (let frame = 2; frame <= (testCase.frames ?? 1); frame++) {
      await scripting.settled();
      player.tick();
    }

    assert.deepEqual(uncaught, []);
    const expected = await readFile(
      fileURLToPath(new URL("../../../player/references/worker-basics/trace.txt", import.meta.url)),
      "utf8",
    );
    assert.deepEqual(lines, expected.trimEnd().split("\n"));
  } finally {
    scripting.destroy();
  }
});

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
 * as the player's tests step them. Its traces, those of its workers mixed
 * in, and its uncaught errors' messages.
 */
async function play(
  name: string,
  primordial: string,
  background: string,
  options: { frames?: number; workerHost?: WorkerHost } = {},
): Promise<{ lines: string[]; uncaught: string[]; scripting: Scripting }> {
  const lines: string[] = [];
  const uncaught: string[] = [];
  const scripting = new Scripting(await createCodegen(wasm), {
    print: (line) => lines.push(line),
    realTime: null,
    onUncaught: (error) => uncaught.push((error as Error).message),
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

  public class ${name} extends Sprite {
    private var n:int = 0;
    private var w:Worker;
    private var ch:MessageChannel;

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
      await scripting.settled();
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
