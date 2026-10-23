// A background worker's thread (docs/workers.md): a VM of its own, codegen,
// runtime and playerglobal, playing the SWF createWorker was given with no
// renderer, sound or input. Its frames run on a timer at the SWF's rate,
// so that its timers, enterFrame and the events it is sent fire. A host
// runs this in a Web Worker or a node worker_threads Worker; nothing here
// knows which.
import { createCodegen } from "@swf2es/codegen";
import { Player } from "../player.js";
import { Scripting } from "../scripting.js";
import type { FromWorker, ToWorker, WorkerInit } from "./protocol.js";

/** What a thread is posted first: codegen's compiled module, and the worker to run. */
export interface ThreadStart {
  codegen: WebAssembly.Module;
  init: WorkerInit;
}

/** How a thread talks to the thread that started it: a Web Worker's global scope, or node's parentPort. */
export interface ThreadPort {
  post(message: FromWorker): void;
  /** Takes each message from the parent, in order: a ThreadStart first, then the rest. */
  listen(receive: (message: ThreadStart | ToWorker) => void): void;
}

/** Run the worker the parent posts, on this thread, until the parent terminates it. */
export function runWorkerThread(port: ThreadPort): void {
  let scripting: Scripting | null = null;
  // Messages that came while the VM was being made, applied once it is.
  const early: ToWorker[] = [];
  // How many of the parent's messages have been applied, the start the first.
  let applied = 0;
  let idled = 0;

  const describe = (error: unknown): string => {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }

    try {
      return scripting ? scripting.rt.toString(error as never) : String(error);
    } catch {
      return "an error that could not be described";
    }
  };

  const boot = async ({ codegen, init }: ThreadStart): Promise<void> => {
    // What the embedder gave the primordial lives on its thread, as
    // functions no message carries: a worker gets none of it, and none of
    // the defaults that would reach past the primordial's (docs/workers.md).
    const storage = new Map<string, Uint8Array>();
    const s = new Scripting(await createCodegen(codegen), {
      url: init.url,
      sandboxType: init.sandboxType,
      print: (line) => port.post({ type: "trace", line }),
      onUncaught: (error) => port.post({ type: "uncaught", text: describe(error) }),
      workerParent: { id: init.id, post: (message) => port.post(message), shared: init.shared },
      audio: null,
      navigate: null,
      fileHost: null,
      clipboard: null,
      webSocket: null,
      sendToUrl: false,
      storage: {
        get: (key) => storage.get(key) ?? null,
        set: (key, bytes) => {
          storage.set(key, bytes.slice());
        },
        remove: (key) => {
          storage.delete(key);
        },
      },
    });
    await s.loadLibraries(init.libraries);
    const player = new Player(init.swf, s);
    scripting = s;
    applied++;
    for (const message of early.splice(0)) {
      s.workers.fromParent(message);
      applied++;
    }

    port.post({ type: "running" });
    await player.start();

    // What was applied before a frame has had its events in it: the parent's settled() waits for that.
    let last = performance.now();
    const frame = () => {
      const upTo = applied;
      const now = performance.now();
      const played = player.advance(now - last);
      last = now;
      if (played > 0 && upTo > idled) {
        idled = upTo;
        port.post({ type: "idle", received: upTo });
      }

      setTimeout(frame, 1000 / player.frameRate);
    };
    setTimeout(frame, 1000 / player.frameRate);
  };

  port.listen((message) => {
    if ("codegen" in message) {
      boot(message).catch((error) => {
        port.post({ type: "uncaught", text: describe(error) });
        port.post({ type: "terminate" });
      });
      return;
    }

    if (!scripting) {
      early.push(message);
      return;
    }

    scripting.workers.fromParent(message);
    applied++;
  });
}
