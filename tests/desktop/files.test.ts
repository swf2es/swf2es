import assert from "node:assert/strict";
import { test } from "node:test";
import { shellFiles } from "../../apps/desktop/dist/renderer/files.js";
import { FileReference, type FileServices } from "../../packages/player/dist/files.js";

for (const failure of ["network", "http", "write"] as const) {
  test(`a ${failure} failure releases the desktop save grant before player destruction`, async () => {
    const lifetime = new AbortController();
    const released: number[] = [];
    const ready: (() => void)[] = [];
    const pending = new Set<Promise<void>>();
    const events: string[] = [];
    const host = shellFiles({
      browse: async () => [],
      save: async () => ({ id: 1, name: "out.txt" }),
      read: async () => new Uint8Array(),
      write: async () => {
        throw new Error("write failed");
      },
      release: (id) => released.push(id),
    });
    const services: FileServices = {
      host,
      signal: lifetime.signal,
      defer: (deliver) => ready.push(deliver),
      track: (task) => {
        pending.add(task);
        void task.finally(() => pending.delete(task));
      },
      fetch: async () => {
        if (failure === "network") {
          throw new Error("network failed");
        }

        return {
          bytes: failure === "http" ? null : Uint8Array.of(65),
          status: failure === "http" ? 404 : 200,
          headers: [],
        };
      },
      error: (id): never => {
        throw new Error(`Error #${id}`);
      },
    };
    const reference = new FileReference(services, (type) => events.push(type));
    try {
      reference.save("out.txt", {
        url: "https://example.test/download",
        method: "GET",
        headers: [],
        body: null,
      });
      for (let i = 0; i < 3; i++) {
        await Promise.all([...pending]);
        for (const deliver of ready.splice(0)) {
          deliver();
        }
      }

      assert.deepEqual(events, ["select", "open", "ioError"]);
      assert.deepEqual(released, [1]);
      reference.cancel();
      lifetime.abort();
      assert.deepEqual(released, [1]);
    } finally {
      lifetime.abort();
    }
  });
}

test("failure cleanup preserves a retry started by the ioError handler", async () => {
  const lifetime = new AbortController();
  const released: number[] = [];
  const writes: number[] = [];
  const ready: (() => void)[] = [];
  const pending = new Set<Promise<void>>();
  let next = 0;
  let requests = 0;
  const host = shellFiles({
    browse: async () => [],
    save: async () => ({ id: ++next, name: "out.txt" }),
    read: async () => new Uint8Array(),
    write: async (id) => {
      writes.push(id);
    },
    release: (id) => {
      released.push(id);
    },
  });
  const services: FileServices = {
    host,
    signal: lifetime.signal,
    defer: (deliver) => {
      ready.push(deliver);
    },
    track: (task) => {
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
    fetch: async () => {
      if (++requests === 1) {
        throw new Error("network failed");
      }

      return { bytes: Uint8Array.of(65), status: 200, headers: [] };
    },
    error: (id): never => {
      throw new Error(`Error #${id}`);
    },
  };
  const request = { url: "https://example.test/download", method: "GET", headers: [], body: null };
  const events: string[] = [];
  const reference = new FileReference(services, (type) => {
    events.push(type);
    if (type === "ioError") {
      reference.save("out.txt", request);
    }
  });
  try {
    reference.save("out.txt", request);
    for (let i = 0; i < 5; i++) {
      await Promise.all([...pending]);
      for (const deliver of ready.splice(0)) {
        deliver();
      }
    }

    assert.deepEqual(events, [
      "select",
      "open",
      "ioError",
      "select",
      "open",
      "progress",
      "complete",
    ]);
    assert.deepEqual(writes, [2]);
    assert.deepEqual(released, [1, 2]);
  } finally {
    lifetime.abort();
  }
});
