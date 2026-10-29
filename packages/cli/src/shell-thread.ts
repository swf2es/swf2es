// A background worker's thread (threads.ts): its ABCs, or the primordial's,
// run after the libraries as runShell runs them, in a runtime that is the
// worker's; the workers it starts run on threads of its own, which it waits
// for once its code ends, as they outlive it in avmshell.
import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { createCodegen } from "@swf2es/codegen";
import {
  createRuntime,
  endShellWorker,
  shellWorkerTerminated,
  startShellWorker,
} from "@swf2es/runtime/avm2";
import { runShell } from "./shell.js";
import { nodeShellThreads, type ShellThreadData } from "./threads.js";

const { codegen, libraries, abcs, init, post, group, memories, apiVersion } =
  workerData as ShellThreadData;
const print = post
  ? (line: string) => parentPort?.postMessage(line)
  : (line: string) => writeSync(1, `${line}\n`);

if (startShellWorker(init)) {
  const threads = nodeShellThreads({
    codegen,
    libraries,
    abcs,
    group,
    memories,
    apiVersion,
    ...(post ? { print } : {}),
  });
  let exception = true;
  try {
    const code = init.code ? [{ name: `worker-${init.id}`, abc: init.code }] : abcs;
    const exitCode = await runShell(libraries, code, {
      compiler: await createCodegen(codegen),
      createRuntime,
      print,
      workers: threads.host,
      worker: init,
      apiVersion,
    });
    exception = exitCode !== 0;
  } catch (e) {
    // Terminated by another worker, its code stops where it was.
    if (!shellWorkerTerminated(init)) {
      print(`swf2es: a background worker failed: ${(e as Error).stack ?? e}`);
    }
  } finally {
    endShellWorker(init, exception);
    await threads.ended();
  }
}
