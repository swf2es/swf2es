// The compiler in Zig behind asc's glue's exports (packages/codegen/src/zig.ts,
// docs/zig-codegen.md): what it stages and lifts as AssemblyScript did, and
// what a call that runs out of memory or panics does.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { instantiate as instantiateAs } from "../../../packages/codegen/dist/codegen.js";
import { createCodegen } from "../../../packages/codegen/dist/index.js";
import { CodegenPanic, fromUtf8, instantiate, toUtf8 } from "../../../packages/codegen/dist/zig.js";
import { builtinLibrary } from "../../../packages/player/dist/playerglobal/libraries.js";
import { linkAbcs } from "../../parity/link-abc.ts";
import { richAbc } from "../../parity/rich-abc.ts";
import { verifyErrorAbcs } from "../../parity/verify-errors.ts";
import { script } from "./ir-cases.ts";
import { bindTesting, zigTestingModule } from "./zig-testing.ts";

// Read the two named binaries even when the shipping filename is temporarily the Zig build.
const compile = async (name: string) =>
  WebAssembly.compile(
    await readFile(new URL(`../../../packages/codegen/${name}`, import.meta.url)),
  );
const zig = await instantiate(await compile("dist/codegen-zig.wasm"));
const as = await instantiateAs(await compile("dist-test/codegen-as.wasm"), { env: {} });

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
  const zigs = new Set(await exports("dist/codegen-zig.wasm"));
  const missing = (await exports("dist-test/codegen-as.wasm")).filter(
    (name) => !name.startsWith("__") && !zigs.has(name),
  );
  assert.deepEqual(missing, []);
});

test("a call that runs out of memory hands out nothing and says so, and does not trap", async () => {
  const { exports } = await WebAssembly.instantiate(await compile("dist/codegen-zig.wasm"), {
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

test("a load that panics Zig's compiler is rejected, and the domain goes on in a new instance", async () => {
  // The test build panics on these two ABCs (root.zig's domainAdd): a
  // safety check, and the stack overflowing.
  const panic = new TextEncoder().encode("\0panic");
  const overflow = new TextEncoder().encode("\0overflow");
  const codegen = await createCodegen(await zigTestingModule(false));
  codegen.reset();
  const main = codegen.childDomain(0);
  assert.equal(codegen.add(script([0x24, 7, 0x24, 5, 0xa0, 0x48]), false, main), 0);
  const first = codegen.compileModuleLogged(["a"], 0);
  const context = codegen.context(0);
  for (const bytes of [panic, overflow]) {
    const revision = codegen.revision();
    assert.equal(codegen.add(bytes, false, main), 1107);
    // The domain as it was: the module, its context and the log alike.
    assert.deepEqual(codegen.context(0), context);
    assert.notEqual(codegen.revision(), revision);
    assert.equal(codegen.compileModule(["a"], 0), first.module);
  }

  assert.equal(codegen.add(script([0x24, 9, 0x48]), false, main), 0);
  assert.equal(codegen.compileModule(["a", "b"], 1).length > 0, true);
});

test("recovery keeps ancestor resolutions after the compiling child is dropped", async () => {
  const compiler = await createCodegen(await zigTestingModule(false));
  const { builtin, user } = linkAbcs();
  compiler.reset();
  assert.equal(compiler.add(builtin, true), 0);
  const child = compiler.childDomain(0);
  assert.equal(compiler.add(user, false, child), 0);
  compiler.compileModule([], 1);
  compiler.dropDomain(child);
  const before = compiler.context(0);
  assert.ok(before?.log);
  assert.equal(compiler.add(new TextEncoder().encode("\0panic")), 1107);
  assert.deepEqual(compiler.context(0), before);
});

test("recovery invalidates a cache read even when the native log returns to its previous length", async () => {
  const compiler = await createCodegen(await zigTestingModule(false));
  compiler.reset();
  assert.equal(compiler.add(builtinLibrary, true), 0);
  const main = compiler.childDomain(0);
  assert.equal(compiler.add(script([0x24, 7, 0x48]), false, main), 0);
  const child = compiler.childDomain(main);
  assert.equal(compiler.add(script([0x24, 9, 0x48]), false, child), 0);
  compiler.compileModule([], 2);
  compiler.dropDomain(child);

  const revision = compiler.revision();
  const key = compiler.keyContext(1);
  assert.equal(compiler.add(new TextEncoder().encode("\0panic")), 1107);
  for (const name of ["Object", "Class", "Function"]) {
    compiler.found({ domain: main, nsKind: 0, uri: "", name, abc: 0, asType: true });
  }

  assert.notDeepEqual(compiler.keyContext(1), key);
  assert.notEqual(compiler.revision(), revision);
});

test("a rejected compile request leaves the current domain recoverable", async () => {
  const compiler = await createCodegen(await zigTestingModule(false));
  compiler.reset();
  assert.equal(compiler.add(script([0x24, 7, 0x48])), 0);
  const key = compiler.keyContext(0);
  assert.throws(() => compiler.compileModule([], 99));
  assert.equal(compiler.add(new TextEncoder().encode("\0panic")), 1107);
  assert.deepEqual(compiler.keyContext(0), key);
});

test("an interrupted verifier cannot replay as a completed verification", async (t) => {
  const module = await zigTestingModule(false);
  t.mock.method(WebAssembly, "instantiate", async (module: WebAssembly.Module, imports: object) => {
    const instance = new WebAssembly.Instance(module, imports);
    const raw = instance.exports as {
      input(size: number): number;
      domainPartBudget(bytes: number): void;
      domainModuleDone(): number;
    };
    raw.domainPartBudget(1);
    let refuseNextInput = false;
    return {
      exports: {
        ...instance.exports,
        domainModuleDone() {
          const done = raw.domainModuleDone();
          refuseNextInput = !done;
          return done;
        },
        input(size: number) {
          if (refuseNextInput) {
            refuseNextInput = false;
            return 0;
          }
          return raw.input(size);
        },
      },
    };
  });

  const compiler = await createCodegen(module);
  compiler.reset();
  assert.equal(compiler.add(builtinLibrary, true), 0);
  assert.throws(() => compiler.compileModule(), /ran out of memory/);
  assert.throws(() => compiler.add(new TextEncoder().encode("\0panic")), CodegenPanic);
});

test("recovery reads a finding's inherited fields once and preserves the finding", async () => {
  const compiler = await createCodegen(await zigTestingModule(false));
  compiler.reset();
  assert.equal(compiler.add(linkAbcs().builtin, true), 0);
  let reads = 0;
  const finding = Object.create({
    domain: 0,
    nsKind: 0,
    uri: "",
    abc: 0,
    asType: true,
    get name() {
      reads++;
      return "A";
    },
  });
  compiler.found(finding);
  const key = compiler.keyContext(0);
  assert.ok(key?.rest);
  assert.equal(compiler.add(new TextEncoder().encode("\0panic")), 1107);
  assert.deepEqual(compiler.keyContext(0), key);
  assert.equal(reads, 1);
});

test("a missing journal entry cannot silently roll back the compiler after a later panic", async (t) => {
  const module = await zigTestingModule(false);
  let failJournal = true;
  t.mock.method(WebAssembly, "instantiate", async (module: WebAssembly.Module, imports: object) => {
    const instance = new WebAssembly.Instance(module, imports);
    const raw = instance.exports as { journalBytes(mark: number): number; codegenError(): number };
    let failed = false;
    return {
      exports: {
        ...instance.exports,
        journalBytes(mark: number) {
          failed = failJournal;
          failJournal = false;
          return raw.journalBytes(mark);
        },
        codegenError() {
          if (failed) {
            failed = false;
            return 1;
          }

          return raw.codegenError();
        },
      },
    };
  });

  const compiler = await createCodegen(module);
  compiler.reset();
  assert.equal(compiler.add(script([0x24, 7, 0x48])), 0);
  assert.throws(() => compiler.compileModule(), /ran out of memory/);
  assert.throws(() => compiler.add(new TextEncoder().encode("\0panic")), CodegenPanic);
});

test("recovery owns the accepted bytes and never consumes an unused revival iterable", async () => {
  const compiler = await createCodegen(await zigTestingModule(false));
  compiler.reset();
  const child = compiler.childDomain(0);
  const bytes = script([0x24, 7, 0x48]);
  assert.equal(compiler.add(bytes, false, child), 0);
  const before = compiler.compileModule([], 0);
  bytes.set(script([0x24, 9, 0x48]));
  compiler.evictDomain(child);
  const bytesToRestore = new Map<number, Uint8Array>();
  bytesToRestore[Symbol.iterator] = () => {
    throw new Error("revival already had its ABC");
  };
  compiler.reviveDomain(child, bytesToRestore);
  assert.equal(compiler.add(new TextEncoder().encode("\0panic")), 1107);
  assert.equal(compiler.compileModule([], 0), before);
});

test("recovery after compaction keeps the generation and restores an evicted child's ABCs", async () => {
  const compiler = await createCodegen(await zigTestingModule(false));
  const builtin = builtinLibrary;
  compiler.reset();
  assert.equal(compiler.add(builtin, true), 0);
  const child = compiler.childDomain(0);
  const user = script([0x24, 7, 0x48]);
  assert.equal(compiler.add(user, false, child), 0);
  const output = compiler.compileModule([], 1);
  compiler.evictDomain(child);

  for (let i = 0; i < 100; i++) {
    const transient = compiler.childDomain(0);
    assert.equal(compiler.add(builtin, true, transient), 0);
    compiler.dropDomain(transient);
  }
  let compacted = compiler.compact();
  if (!compacted) {
    await new Promise((resolve) => setImmediate(resolve));
    compacted = compiler.compact();
  }
  assert.ok(compacted);
  const revision = compiler.revision();
  const key = compiler.keyContext(0);
  const panic = new TextEncoder().encode("\0panic");
  assert.equal(compiler.add(panic), 1107);
  assert.notEqual(compiler.revision(), revision);
  assert.deepEqual(compiler.keyContext(0), key);
  assert.throws(() => compiler.reviveDomain(child, new Map()));
  compiler.reviveDomain(child, new Map([[1, user]]));
  const revived = compiler.revision();
  assert.equal(compiler.add(panic), 1107);
  assert.notEqual(compiler.revision(), revived);
  assert.equal(compiler.compileModule([], 1), output);
});
