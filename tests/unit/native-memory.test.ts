import assert from "node:assert/strict";
import { test } from "node:test";
import { deflate, memoryInUse } from "@swf2es/native/compress";
import { nativeMemory } from "@swf2es/native/memory";
import { Tessellator } from "@swf2es/native/render";

test("nativeMemory counts the memories of the modules' live instances", () => {
  deflate(
    new Uint8Array(1 << 16).map((_, i) => i % 251),
    6,
    false,
  );
  // compress keeps its instance between calls: its memory is among them.
  assert.ok(memoryInUse() > 0);
  const withCompress = nativeMemory();
  assert.ok(withCompress >= memoryInUse(), `${withCompress} for ${memoryInUse()}`);

  // A tessellator's instance, made as it first fills, is counted too.
  const tessellator = new Tessellator();
  assert.ok(tessellator.tessellate([[0, 0, 10, 0, 10, 10, 0, 10]], false));
  assert.ok(nativeMemory() >= withCompress + tessellator.capacity);
  assert.ok(nativeMemory() > withCompress, `${nativeMemory()} after ${withCompress}`);
});
