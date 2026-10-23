// flash.system's workers through a SWF's scripts: a background worker
// started on a node worker_threads thread, played against Flash's trace of
// the same case, and what a player without a worker host reports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createCodegen } from "@swf2es/codegen";
import { containerEngine } from "../../../../oracle/oracle.ts";
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
