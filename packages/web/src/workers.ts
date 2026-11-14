// A SWF's Web Workers as the element starts them: whether its ActionScript
// names WorkerDomain, the host, and how long its first frame waits for them.
import { type Swf, tags } from "@swf2es/format";
import type { WebWorkerHost } from "@swf2es/player-hosts/workers";
import { workerHostForPlayer } from "./config.js";

/** The bytes of "WorkerDomain", the class a SWF's ActionScript names to start a worker. */
const WORKER_DOMAIN = new TextEncoder().encode("WorkerDomain");

/**
 * Whether a SWF's ActionScript names WorkerDomain, in its ABCs' strings:
 * one that does may start a worker and wait for it in the same script,
 * which only a Web Worker started ahead can answer.
 */
export function namesWorkers(swf: Swf): boolean {
  const bytes = swf.bytes;
  const first = WORKER_DOMAIN[0];
  for (const tag of swf.tags) {
    if (tag.code !== tags.DoABC && tag.code !== tags.DoABC2) {
      continue;
    }

    const end = tag.offset + tag.length - WORKER_DOMAIN.length;
    for (let at = bytes.indexOf(first, tag.offset); at !== -1 && at <= end; ) {
      let k = 1;
      while (k < WORKER_DOMAIN.length && bytes[at + k] === WORKER_DOMAIN[k]) {
        k++;
      }

      if (k === WORKER_DOMAIN.length) {
        return true;
      }

      at = bytes.indexOf(first, at + 1);
    }
  }

  return false;
}

/**
 * How long a SWF that names workers waits for the Web Workers started
 * ahead before its first frame: past it, it plays on, and a worker it
 * starts takes one still loading.
 */
export const READY_WAIT = 10_000;

/** A player's Web Workers, or none where their module does not load, as under an import map that does not name it. */
export async function workersOrNone(ahead: boolean): Promise<WebWorkerHost | null> {
  try {
    return await workerHostForPlayer(ahead);
  } catch (error) {
    console.warn(`swf2es: workers are off, as their host did not load: ${error}`);
    return null;
  }
}
