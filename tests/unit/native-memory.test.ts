import assert from "node:assert/strict";
import { test } from "node:test";
import { deflate, memoryInUse } from "@swf2es/native/compress";
import { nativeMemory } from "@swf2es/native/memory";
import { execNamed } from "@swf2es/native/regexp";
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

test("named RegExp searches reuse their frames and release replaced patterns and subjects", () => {
  const pattern = "(?P<first>a)b[cd]";
  const run = (source: string, text: string) => execNamed(source, "", false, text, 0)?.[0];
  assert.equal(run(pattern, "abc"), "abc");
  const warm = nativeMemory();
  const subject = `${"aba".repeat(8192)}abc`;
  assert.equal(run(pattern, subject), "abc");
  // The input fits in one Wasm page. Thousands of failed positions need only
  // a few live frames, even within this single search.
  assert.ok(nativeMemory() <= warm + 2 * 65536);

  const cycle = () => {
    for (let i = 0; i < 32; i++) {
      const source = i % 2 ? pattern : "(?P<first>a)bc";
      assert.equal(run(source, subject), "abc");
      assert.equal(run(source, "abcd"), "abc");
    }
  };
  cycle();
  const capacity = nativeMemory();
  cycle();
  assert.equal(nativeMemory(), capacity);
});

test("a named RegExp subject reuses the source buffer after compilation", () => {
  const padding = "a".repeat(2 ** 20);
  const source = `(?P<word>a)#${padding}`;
  assert.equal(execNamed(source, "", true, "a", 0)?.[0], "a");
  const compiled = nativeMemory();
  assert.equal(execNamed(source, "", true, `${padding}b`, 0)?.[0], "a");
  assert.ok(nativeMemory() <= compiled + 65536);
});
