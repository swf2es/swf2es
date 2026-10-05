import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMPILER_VERSION, cacheKey, createCodegen } from "@swf2es/codegen";
import { script } from "./ir-cases.ts";
import { testing } from "./testing-module.ts";

const wasmPath = fileURLToPath(import.meta.resolve("@swf2es/codegen/codegen.wasm"));
const module = await WebAssembly.compile(await readFile(wasmPath));

test("codegen.wasm imports nothing but abort", () => {
  // Purity is what makes JIT and AOT output identical: the compiler can't
  // reach a clock, randomness or the host environment if it can't import them.
  assert.deepEqual(
    WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`),
    ["env.abort"],
  );
});

test("wrapper and wasm agree on the compiler version", async () => {
  await createCodegen(module); // throws on a mismatch
  assert.equal(cacheKey("abc123"), `swf2es@${COMPILER_VERSION}:abc123`);
  assert.equal(cacheKey("abc123", ["b1", "s2"]), `swf2es@${COMPILER_VERSION}:b1+s2+abc123`);
});

test("a cache key names what the ABC's application domain was recorded to find", () => {
  const found = (name: string, hash: string, asType = true) => ({
    nsKind: 0,
    uri: "p",
    name,
    hash,
    asType,
  });
  const plain = cacheKey("abc123", ["b1"]);
  const child = cacheKey("abc123", ["b1"], [found("C", "child")]);
  assert.equal(cacheKey("abc123", ["b1"], []), plain);
  assert.notEqual(child, plain);
  // Another definition, the same one by name rather than as a type, or a
  // name that would spell the same with a separator in it: another key.
  assert.notEqual(cacheKey("abc123", ["b1"], [found("C", "parent")]), child);
  assert.notEqual(cacheKey("abc123", ["b1"], [found("C", "child", false)]), child);
  assert.notEqual(
    cacheKey("abc123", ["b1"], [{ ...found("C", "child"), uri: "p::C" }]),
    cacheKey("abc123", ["b1"], [{ ...found("C::C", "child"), uri: "p" }]),
  );
  // The same findings in another order: the same key.
  assert.equal(
    cacheKey("abc123", ["b1"], [found("C", "child"), found("D", "child")]),
    cacheKey("abc123", ["b1"], [found("D", "child"), found("C", "child")]),
  );
});

test("reads the ABC version header", async () => {
  const codegen = await createCodegen(module);
  // Flash Player 9+ ABC: minor 16, major 46 (both little-endian u16).
  assert.deepEqual(codegen.abcVersion(new Uint8Array([16, 0, 46, 0, 0xff])), {
    major: 46,
    minor: 16,
  });
  assert.equal(codegen.abcVersion(new Uint8Array([16, 0, 46])), null);
});

test("the wrapper makes application domains, numbered from the root's 0", async () => {
  const codegen = await createCodegen(module);
  codegen.reset();
  const child = codegen.childDomain(0);
  assert.equal(child, 1);
  assert.equal(codegen.childDomain(child), 2);
  // A finding no ABC can satisfy is left out, not a trap.
  codegen.found({ domain: child, nsKind: 0, uri: "p", name: "a", abc: 0, asType: true });
});

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";

test("the release build compiles what the test build compiles, byte for byte", {
  skip,
}, async () => {
  // A script that returns 7 + 5, linked against the builtins, compiled
  // whole and a method at a time by both builds of the same source.
  const builtin = new Uint8Array(await readFile(new URL("builtin.abc", generated)));
  const abc = script([0x24, 7, 0x24, 5, 0xa0, 0x48]);
  const codegen = await createCodegen(module);
  codegen.reset();
  assert.equal(codegen.add(builtin, true), 0);
  assert.equal(codegen.add(abc), 0);
  const compiled = codegen.compile(["b", "a"]);

  testing.domainReset(50);
  testing.domainAdd(builtin, true);
  testing.domainAdd(abc, false);
  assert.equal(compiled.module, testing.domainModule("b\na"));
  assert.equal(compiled.sourceMap, testing.domainSourceMap());
  assert.ok(compiled.entries.size > 0);
  assert.deepEqual(codegen.compileMethods([...compiled.entries.keys()]), compiled.entries);
  assert.match(compiled.module, /7/);

  // Nothing asked for, or bodies the ABC has not: nothing, not body 0 or a trap.
  assert.deepEqual(codegen.compileMethods([]), new Map());
  assert.deepEqual(codegen.compileMethods([9999, -1, 1.5]), new Map());
  // Verified once: asking again gives the same, from the cache.
  assert.deepEqual(codegen.compileMethods([0]), new Map([[0, compiled.entries.get(0) ?? ""]]));

  // By index: the last is the default, an earlier one compiles against the
  // later too, and one not added is an error, not a trap.
  assert.equal(codegen.compile(["b", "a"], 1).module, compiled.module);
  assert.equal(codegen.compile(["b", "a"], 0).module, testing.domainModule("b\na", 0));
  assert.deepEqual(codegen.compileMethods([...compiled.entries.keys()], 1), compiled.entries);
  assert.throws(() => codegen.compile(["b", "a"], 2), /only 2 have been added/);

  // The module alone is compile's, by default and by index.
  assert.equal(codegen.compileModule(["b", "a"]), compiled.module);
  assert.equal(codegen.compileModule(["b", "a"], 0), testing.domainModule("b\na", 0));
  assert.throws(() => codegen.compileModule(["b", "a"], 2), /only 2 have been added/);
});

test("a module's source map and entries are written when asked for, from it alone", () => {
  testing.domainReset(50);
  testing.domainAdd(script([0x24, 7, 0x24, 5, 0xa0, 0x48]), false);
  const module = testing.domainModule("a");
  const sourceMap = testing.domainSourceMap();
  const entries = testing.domainModuleEntries();
  assert.ok(entries.length > 0);

  // Asked again, after a method compiled alone between: the same.
  testing.domainEmitEach("0", true);
  assert.equal(testing.domainSourceMap(), sourceMap);
  assert.equal(testing.domainModuleEntries(), entries);

  // A module not kept: the same module, and nothing left to ask for.
  assert.equal(testing.domainModule("a", -1, false), module);
  assert.equal(testing.domainSourceMap(), "");
  assert.equal(testing.domainModuleEntries(), "");
});

test("compiling before an ABC is added is an error, not a trap", async () => {
  const codegen = await createCodegen(module);
  codegen.reset();
  assert.throws(() => codegen.compile(), /no ABC has been added/);
  assert.throws(() => codegen.compileModule(), /no ABC has been added/);
  assert.throws(() => codegen.compileMethods([0]), /no ABC has been added/);
  // An ABC the domain rejects does not count as added.
  assert.notEqual(codegen.add(new Uint8Array([16, 0, 46, 0, 1, 2, 3])), 0);
  assert.throws(() => codegen.compile(), /no ABC has been added/);
});
