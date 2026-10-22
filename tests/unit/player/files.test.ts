import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FileReference,
  type FileServices,
  type SelectedFile,
} from "../../../packages/player/dist/files.js";
import type { FetchRequest } from "../../../packages/player/dist/hosts.js";

const selected: SelectedFile = {
  name: "héllo.bin",
  size: 3,
  modificationDate: 123,
  read: async () => Uint8Array.of(0, 127, 255),
};

function harness() {
  const lifetime = new AbortController();
  const ready: (() => void)[] = [];
  const pending = new Set<Promise<void>>();
  const events: string[] = [];
  const writes: Uint8Array[] = [];
  const requests: FetchRequest[] = [];
  const services: FileServices = {
    host: {
      browse: async () => [selected],
      save: async (name) => ({
        name,
        write: async (bytes) => {
          writes.push(bytes);
        },
      }),
    },
    signal: lifetime.signal,
    defer: (deliver) => ready.push(deliver),
    track: (task) => {
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
    fetch: async (request) => {
      requests.push(request);
      return { bytes: new TextEncoder().encode("ok"), status: 200, headers: [] };
    },
    error: (id): never => {
      throw new Error(`Error #${id}`);
    },
  };
  const reference = new FileReference(services, (type) => events.push(type));
  const frame = async () => {
    await Promise.all([...pending]);
    for (const deliver of ready.splice(0)) {
      deliver();
    }
  };
  // A frame that begins at once, with no promise settled since: the player's first, after
  // the document class's constructor.
  const nextFrame = () => {
    for (const deliver of ready.splice(0)) {
      deliver();
    }
  };
  return { reference, services, events, writes, requests, frame, nextFrame, lifetime };
}

test("selection and load cross the frame boundary; cancellation drops stale results", async () => {
  const h = harness();
  assert.throws(() => h.reference.load(), /2037/);
  h.reference.browse([]);
  assert.equal(h.reference.file, null);
  assert.deepEqual(h.events, []);
  assert.throws(() => h.reference.browse([]), /2174/);
  await h.frame();
  assert.equal(h.reference.file, selected);
  h.reference.load();
  assert.equal(h.reference.data, null);
  await h.frame();
  assert.deepEqual(h.reference.data, Uint8Array.of(0, 127, 255));
  assert.deepEqual(h.events, ["select", "open", "progress", "complete"]);
  h.reference.browse([]);
  h.reference.cancel();
  await h.frame();
  assert.equal(h.events.length, 4);
  h.reference.load();
  h.lifetime.abort();
  await h.frame();
  assert.equal(h.events.length, 4);
});

test("save snapshots bytes and downloads fetch only after a destination was selected", async () => {
  const h = harness();
  h.reference.save("a.bin", Uint8Array.of(1, 2));
  await h.frame();
  assert.deepEqual(h.events, ["select", "open"]);
  await h.frame();
  assert.deepEqual(h.writes, [Uint8Array.of(1, 2)]);
  assert.deepEqual(h.events, ["select", "open", "progress", "complete"]);
  h.services.host = { browse: async () => [], save: async () => null };
  h.reference.save("b.bin", {
    url: "https://example.test/b",
    method: "GET",
    headers: [],
    body: null,
  });
  await h.frame();
  assert.equal(h.requests.length, 0);
  assert.equal(h.events.at(-1), "cancel");
});

test("a dialog a host refuses at once cancels in the very next frame", () => {
  const h = harness();
  h.services.host = { browse: () => [], save: () => null };
  h.reference.browse([]);
  assert.deepEqual(h.events, []);
  h.nextFrame();
  assert.deepEqual(h.events, ["cancel"]);
  h.reference.save("a.bin", Uint8Array.of(1));
  h.nextFrame();
  assert.deepEqual(h.events, ["cancel", "cancel"]);
  h.services.host = null;
  h.reference.browse([]);
  h.nextFrame();
  assert.deepEqual(h.events, ["cancel", "cancel", "cancel"]);
});

test("multipart preserves binary bytes and URLVariables; raw upload sends the file alone", async () => {
  const h = harness();
  h.reference.file = selected;
  const request: FetchRequest = {
    url: "https://example.test/upload",
    method: "POST",
    headers: [],
    body: new TextEncoder().encode("x=a%26b"),
  };
  h.reference.upload(request, "custom");
  await h.frame();
  const sent = h.requests[0];
  const form = await new Response(sent.body?.slice().buffer, {
    headers: sent.headers as [string, string][],
  }).formData();
  assert.equal(form.get("x"), "a&b");
  assert.equal(form.get("Filename"), selected.name);
  const file = form.get("custom") as File;
  assert.equal(file.name, selected.name);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), Uint8Array.of(0, 127, 255));
  assert.deepEqual(h.events, ["open", "progress", "complete", "uploadCompleteData"]);
  h.reference.upload(request, null);
  await h.frame();
  assert.deepEqual(h.requests[1].body, Uint8Array.of(0, 127, 255));
});

test("cancel in select suppresses the download and write", async () => {
  const h = harness();
  const reference = new FileReference(h.services, (type) => {
    if (type === "select") {
      reference.cancel();
    }
  });
  reference.save("b.bin", {
    url: "https://example.test/b",
    method: "GET",
    headers: [],
    body: null,
  });
  await h.frame();
  await h.frame();
  assert.equal(h.requests.length, 0);
  assert.equal(h.writes.length, 0);
});

test("HTTP upload failure reports its status and never completes", async () => {
  const h = harness();
  h.services.fetch = async () => ({ bytes: null, status: 403, headers: [] });
  h.reference.file = selected;
  h.reference.upload(
    { url: "https://example.test/upload", method: "POST", headers: [], body: null },
    null,
  );
  await h.frame();
  assert.deepEqual(h.events, ["open", "progress", "httpStatus", "ioError"]);
});

test("testUpload probes with an empty body only for files over 10 KB", async () => {
  const h = harness();
  h.reference.file = { ...selected, size: 10241, read: async () => new Uint8Array(10241) };
  const request: FetchRequest = {
    url: "https://example.test/upload",
    method: "POST",
    headers: [],
    body: null,
  };
  h.reference.upload(request, null, true);
  await h.frame();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].body?.length, 0);
  assert.equal(h.requests[1].body?.length, 10241);
  h.reference.file = selected;
  h.reference.upload(request, null, true);
  await h.frame();
  assert.equal(h.requests.length, 3);
});

test("a complete listener can start another operation without receiving stale upload data", async () => {
  const h = harness();
  const events: string[] = [];
  const reference = new FileReference(h.services, (type) => {
    events.push(type);
    if (type === "complete") {
      reference.browse([]);
    }
  });
  reference.file = selected;
  reference.upload(
    { url: "https://example.test/upload", method: "POST", headers: [], body: null },
    null,
  );
  await h.frame();
  assert.deepEqual(events, ["open", "progress", "complete"]);
  await h.frame();
  assert.equal(events.at(-1), "select");
});
