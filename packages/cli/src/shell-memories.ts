// The shared memory of a primordial's threads, kept by a thread of its own
// (threads.ts): every shareable ByteArray's memory a thread shares is
// posted on the group's BroadcastChannel, which this thread, its event
// loop always free, keeps, and answers a thread that asks for one it
// missed, as one does that was still starting when the memory was shared.
import { workerData } from "node:worker_threads";
import type { SharedBytesMemory } from "@swf2es/runtime/avm2";
import type { MemoriesData, MemoryMessage } from "./threads.js";

const { group, memories: seen, ready } = workerData as MemoriesData;
const memories = new Map<number, SharedBytesMemory>(seen.map((m) => [m.id, m]));
const channel = new BroadcastChannel(group);
channel.onmessage = (event) => {
  const message = (event as unknown as { data: MemoryMessage }).data;
  switch (message.type) {
    case "memory":
      memories.set(message.memory.id, message.memory);
      break;
    case "ask":
      channel.postMessage({
        type: "answer",
        id: message.id,
        memory: memories.get(message.id) ?? null,
      } satisfies MemoryMessage);
      Atomics.store(message.answered, 0, 1);
      Atomics.notify(message.answered, 0);
      break;
    case "answer":
      break;
  }
};

// Subscribed: the threads may start.
Atomics.store(ready, 0, 1);
Atomics.notify(ready, 0);
