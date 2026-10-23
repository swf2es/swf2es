// The CLI's threads' shared memory: a thread that was still starting when
// another shared a memory, and so missed it on the group's channel, gets
// it from the primordial's memory thread when a shared property names it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nodeShellThreads } from "../../../packages/cli/dist/threads.js";

const options = { codegen: {} as WebAssembly.Module, libraries: [], abcs: [] };
const memory = (id: number) => ({
  id,
  meta: new SharedArrayBuffer(8),
  data: new SharedArrayBuffer(16),
});

test("a thread that missed a shared memory while it started gets it from the memory thread", async () => {
  const primordial = nodeShellThreads(options);
  const sibling = nodeShellThreads({ ...options, group: primordial.group, memories: [] });
  try {
    // The primordial's first share starts the memory thread.
    const early = memory(1);
    primordial.host.share?.(early);
    // A sibling shares one before the starting thread has made its channel.
    const missed = memory(2);
    sibling.host.share?.(missed);
    const late = nodeShellThreads({ ...options, group: primordial.group, memories: [] });
    try {
      const found = late.host.shared?.(missed.id);
      assert.ok(found, "the memory thread answered");
      new Uint8Array(found.data)[3] = 9;
      assert.equal(new Uint8Array(missed.data)[3], 9);
      assert.equal(late.host.shared?.(early.id)?.id, early.id);
      assert.equal(late.host.shared?.(999), undefined);
    } finally {
      await late.close();
    }
  } finally {
    await sibling.close();
    await primordial.close();
  }
});
