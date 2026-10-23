// webWorkerHost's workers started ahead, on Web Workers faked in node: a
// host's `ready` settles once each worker it started ahead has loaded or
// failed, though another host of the page took it before it loaded.
import assert from "node:assert/strict";
import { test } from "node:test";
import { webWorkerHost } from "@swf2es/player-hosts/workers";

interface Message {
  data: unknown;
}

const made: FakeWorker[] = [];

class FakeWorker {
  onmessage: ((event: Message) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  terminated = false;

  constructor() {
    made.push(this);
  }

  postMessage(): void {}

  terminate(): void {
    this.terminated = true;
  }

  loaded(): void {
    this.onmessage?.({ data: { type: "ready" } });
  }
}

(globalThis as { Worker?: unknown }).Worker = FakeWorker;
const codegen = {} as WebAssembly.Module;
const settles = (promise: Promise<void>) =>
  Promise.race([
    promise.then(() => "settled"),
    new Promise((done) => setTimeout(() => done("hung"), 200)),
  ]);

test("a host's ready settles though another host took its workers before they loaded", async () => {
  made.length = 0;
  const ahead = webWorkerHost({ codegen, url: "https://test.invalid/a.js", spares: 2 });
  const other = webWorkerHost({ codegen, url: "https://test.invalid/a.js", spares: 0 });
  other.start(
    {} as never,
    () => {},
    () => {},
  );
  for (const worker of made) {
    worker.loaded();
  }

  assert.equal(await settles(ahead.ready), "settled");
  ahead.release?.();
  other.release?.();
});

test("a host's ready settles though its worker was taken and terminated before it loaded", async () => {
  made.length = 0;
  const ahead = webWorkerHost({ codegen, url: "https://test.invalid/b.js", spares: 1 });
  const other = webWorkerHost({ codegen, url: "https://test.invalid/b.js", spares: 0 });
  const thread = other.start(
    {} as never,
    () => {},
    () => {},
  );
  void thread.terminate();
  assert.equal(made[0].terminated, true);
  assert.equal(await settles(ahead.ready), "settled");
  ahead.release?.();
  other.release?.();
});
