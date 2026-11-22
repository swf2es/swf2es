// The compiler in Zig behind asc's glue's exports (packages/codegen/src/zig.ts,
// docs/zig-codegen.md): what it stages and lifts as AssemblyScript did, and
// what a call that runs out of memory or panics does.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { instantiate as instantiateAs } from "../../../packages/codegen/dist/codegen.js";
import { CodegenPanic, fromUtf8, instantiate, toUtf8 } from "../../../packages/codegen/dist/zig.js";
import { linkAbcs } from "../../parity/link-abc.ts";
import { richAbc } from "../../parity/rich-abc.ts";
import { verifyErrorAbcs } from "../../parity/verify-errors.ts";
import { bindTesting, zigTestingModule } from "./zig-testing.ts";

// From dist/ by name, not by the package's export, which SWF2ES_COMPILER=zig redirects (tests/compiler.ts).
const compile = async (name: string) =>
  WebAssembly.compile(
    await readFile(new URL(`../../../packages/codegen/dist/${name}`, import.meta.url)),
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

test("Zig's compiler has every export of AssemblyScript's but its runtime's", async () => {
  const exports = async (file: string) =>
    WebAssembly.Module.exports(await compile(file)).map((e) => e.name);
  const zigs = new Set(await exports("codegen-zig.wasm"));
  const missing = (await exports("codegen.wasm")).filter(
    (name) => !name.startsWith("__") && !zigs.has(name),
  );
  assert.deepEqual(missing, []);
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

test("running out of memory through the wrapper is a plain Error, and the instance lives on", async () => {
  const testing = await bindTesting(await zigTestingModule(false));
  assert.throws(
    () => testing.abcVersion(new Uint8Array(0xfff0_0000)),
    (e) => !(e instanceof CodegenPanic) && /ran out of memory/.test((e as Error).message),
  );
  assert.equal(testing.panicked(), null);
  assert.equal(testing.compilerVersion(), "0.0.0");
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

test("any other trap, as a stack overflow, kills the instance as a panic does", async () => {
  const testing = await bindTesting(await zigTestingModule(false));
  // How deep the stack has reached since it was painted, for the fuzzers to size it by.
  testing.stackPaint();
  assert.ok(testing.stackDeepest() > 0 && testing.stackDeepest() < 4096);
  assert.throws(() => testing.testingOverflow(0), CodegenPanic);
  assert.match(testing.panicked() ?? "", /^trap: /);
  assert.throws(() => testing.compilerVersion(), CodegenPanic);
});

test("a view of the module's own memory goes in whole, though input gives that memory back", async () => {
  const testing = await bindTesting(await zigTestingModule(false));
  const view = new Uint8Array(testing.memory.buffer, 64, 4);
  view.set([16, 0, 46, 0]);
  assert.equal(testing.abcVersion(view), (46 << 16) | 16);
});

test("arrays and strings must be given, as asc's glue requires; a default only where left out", () => {
  assert.throws(() => zig.abcVersion(undefined as unknown as Uint8Array), TypeError);
});

/** Byte array `name` of a Zig source of the test build's. */
async function zigBytes(file: string, name: string): Promise<number[]> {
  const source = await readFile(
    new URL(`../../../packages/codegen/zig/src/testing/${file}`, import.meta.url),
    "utf8",
  );
  const body = source.match(new RegExp(`pub const ${name} = \\[_\\]u8\\{([^}]*)\\};`))?.[1];
  assert.ok(body, `${name} in ${file}`);
  return body
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(Number);
}

test("the Zig tests' ABCs are the ones tests/parity builds", async () => {
  assert.deepEqual(await zigBytes("abc.zig", "rich_abc"), [...richAbc(true)]);
  const { builtin, user, failing, wide, created } = linkAbcs();
  assert.deepEqual(await zigBytes("domain.zig", "link_builtin"), [...builtin]);
  assert.deepEqual(await zigBytes("domain.zig", "link_user"), [...user]);
  assert.deepEqual(await zigBytes("domain.zig", "link_failing"), [...failing]);
  assert.deepEqual(await zigBytes("domain.zig", "link_wide"), [...wide]);
  assert.deepEqual(await zigBytes("domain.zig", "link_created"), [...created]);
  assert.deepEqual(await zigBytes("domain.zig", "link_contested"), [...verifyErrorAbcs()[2][1]]);
});
