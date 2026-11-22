// The compiler in Zig behind asc's glue's exports (packages/codegen/src/zig.ts,
// docs/zig-codegen.md): what it stages and lifts as AssemblyScript did, and
// what a call that runs out of memory or panics does.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { instantiate as instantiateAs } from "../../../packages/codegen/dist/codegen.js";
import { CodegenPanic, fromUtf8, instantiate, toUtf8 } from "../../../packages/codegen/dist/zig.js";
import { bindTesting, zigTestingModule } from "./zig-testing.ts";

const compile = async (name: string) =>
  WebAssembly.compile(
    await readFile(fileURLToPath(import.meta.resolve(`@swf2es/codegen/${name}`))),
  );
const zig = await instantiate(await compile("codegen-zig.wasm"));
const as = await instantiateAs(await compile("codegen.wasm"), { env: {} });

test("strings go in as AssemblyScript's String.UTF8.encode wrote them: WTF-8", () => {
  assert.deepEqual([...toUtf8("aé€")], [0x61, 0xc3, 0xa9, 0xe2, 0x82, 0xac]);
  assert.deepEqual([...toUtf8("\u{1f600}")], [0xf0, 0x9f, 0x98, 0x80]);
  // Lone surrogates, which TextEncoder writes as U+FFFD.
  assert.deepEqual([...toUtf8("\ud800x")], [0xed, 0xa0, 0x80, 0x78]);
  assert.deepEqual([...toUtf8("\udc00")], [0xed, 0xb0, 0x80]);
  assert.deepEqual([...toUtf8("\ud800")], [0xed, 0xa0, 0x80]);
});

test("strings come out as AssemblyScript's String.UTF8.decodeUnsafe read them", () => {
  const read = (bytes: number[]) => fromUtf8(Uint8Array.from(bytes));
  assert.equal(read([0x61, 0xc3, 0xa9]), "aé");
  // A byte order mark is kept, as AssemblyScript keeps it.
  assert.equal(read([0xef, 0xbb, 0xbf, 0x61]), "﻿a");
  // WTF-8's lone surrogate, as toUtf8 writes it.
  assert.equal(read([0xed, 0xa0, 0x80]), "\ud800");
  // A sequence cut short at the end is dropped, not U+FFFD.
  assert.equal(read([0x61, 0xe2, 0x82]), "a");
  assert.equal(read([0x61, 0xc3]), "a");
  // An overlong form is read for its bits.
  assert.equal(read([0xc0, 0xaf]), "/");
  // A stray continuation byte begins a sequence of four.
  assert.equal(read([0x80, 0x41, 0x41, 0x41, 0x62]), `${String.fromCharCode(0x1041)}b`);
  // Past U+10FFFF, a pair all the same.
  assert.equal(read([0xf7, 0xbf, 0xbf, 0xbf]), "\udfbf\udfff");
});

test("the compilers agree on what Zig's has ported", () => {
  assert.equal(zig.compilerVersion(), as.compilerVersion());
  for (const bytes of [
    [],
    [16, 0, 46],
    [16, 0, 46, 0],
    [16, 0, 46, 0, 9],
    [0xff, 0xff, 0xff, 0xff],
  ]) {
    assert.equal(zig.abcVersion(Uint8Array.from(bytes)), as.abcVersion(Uint8Array.from(bytes)));
  }
});

test("an export Zig's compiler has not ported yet throws when it is called", () => {
  assert.throws(() => zig.domainReset(0), /codegen-zig.wasm has no domainReset yet/);
});

test("a call that runs out of memory hands out nothing and says so, and does not trap", async () => {
  const { exports } = await WebAssembly.instantiate(await compile("codegen-zig.wasm"), {
    env: { abort: () => assert.fail("abort") },
  });
  const raw = exports as { input(size: number): number; codegenError(): number };
  assert.equal(raw.input(0xffff_ffff), 0);
  assert.equal(raw.codegenError(), 1);
  assert.notEqual(raw.input(16), 0);
  assert.equal(raw.codegenError(), 0);
});

test("a panic is thrown as a CodegenPanic, and the instance is dead after it", async () => {
  const testing = await bindTesting(await zigTestingModule(false));
  assert.equal(testing.panicked(), null);
  assert.throws(
    () => testing.testingPanic(),
    (e) => e instanceof CodegenPanic && /a panic for the tests/.test(e.message),
  );
  assert.equal(testing.panicked(), "a panic for the tests");
  assert.throws(() => testing.compilerVersion(), CodegenPanic);
});
