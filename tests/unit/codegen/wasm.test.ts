import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMPILER_VERSION, cacheKey, createCodegen } from "@swf2es/codegen";
import { abc, tables, u30 } from "./abc-builder.ts";
import { script } from "./ir-cases.ts";
import { classes, METHOD, mn, pool, SLOT } from "./link-cases.ts";
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

test("the wrapper drops an application domain, whose ABCs then compile no more", async () => {
  const codegen = await createCodegen(module);
  codegen.reset();
  assert.equal(codegen.add(script([0x47])), 0);
  const child = codegen.childDomain(0);
  assert.equal(codegen.add(script([0x24, 1, 0x48]), false, child), 0);
  const sibling = codegen.childDomain(0);
  assert.equal(codegen.add(script([0x24, 2, 0x48]), false, sibling), 0);
  const compiled = codegen.compileModule(["a", "b", "c"], 2);

  codegen.dropDomain(child);
  assert.throws(() => codegen.childDomain(child), /dropped/);
  assert.throws(() => codegen.add(script([0x47]), false, child), /dropped/);
  assert.throws(() => codegen.compileModule(["a", "", "c"], 1), /dropped/);
  // The others keep their indices and compile as they did; the next is the fourth.
  assert.equal(codegen.compileModule(["a", "", "c"], 2), compiled);
  assert.equal(codegen.add(script([0x24, 3, 0x48]), false, codegen.childDomain(0)), 0);
  assert.match(codegen.compileModule(["a", "", "c", "d"]), /hash: "d",\s+linked: \["a"\]/);
});

test("the wrapper evicts an application domain and revives it given its ABCs", async () => {
  const codegen = await createCodegen(module);
  codegen.reset();
  assert.equal(codegen.add(script([0x47])), 0);
  const child = codegen.childDomain(0);
  const abc = script([0x24, 1, 0x48]);
  assert.equal(codegen.add(abc, false, child), 0);
  const compiled = codegen.compileModule(["a", "b"], 1);

  codegen.evictDomain(child);
  assert.equal(codegen.isLive(child), false);
  assert.throws(() => codegen.compileModule(["a", "b"], 1), /dropped/);
  assert.throws(() => codegen.childDomain(child), /dropped/);
  // Too little to be worth a rebuild, with memory nowhere near growing:
  // its ABC is linked still.
  const usage = codegen.usage();
  assert.ok(
    usage.live > 0 && usage.dead > 0 && usage.memory > usage.live + usage.dead,
    JSON.stringify(usage),
  );
  assert.equal(codegen.compact(), false);
  codegen.reviveDomain(child, new Map());
  assert.equal(codegen.isLive(child), true);
  assert.equal(codegen.compileModule(["a", "b"], 1), compiled);
  assert.throws(() => codegen.reviveDomain(child, new Map()), /not evicted/);
});

test("a drop of a domain reset since is ignored", async () => {
  const codegen = await createCodegen(module);
  codegen.reset();
  const epoch = codegen.epoch;
  const child = codegen.childDomain(0);
  codegen.reset();
  assert.equal(codegen.epoch, epoch + 1);
  assert.equal(codegen.childDomain(0), child);
  codegen.dropDomain(child, epoch);
  assert.equal(codegen.isLive(child), true);
  codegen.dropDomain(child, codegen.epoch);
  assert.equal(codegen.isLive(child), false);
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

test("codegen.wasm carries the hash of its bytes as its identity", async () => {
  const codegen = await createCodegen(module);
  assert.match(codegen.identity ?? "", /^[0-9a-f]{64}$/);
});

/**
 * What a module cache relies on: B's slot x is of type A, found in B's
 * domain; the main domain above then gains another A, whose m has another
 * dispatch id, and C calls new B().x.m(). What C compiles to depends on
 * whether B's slot was resolved before that A came, as compiling B does.
 * B's module from a cache, its compile's log replayed, leaves the domain as
 * compiling it did, so C compiles alike; skipped, C compiles otherwise,
 * and its context says so.
 */
test("a module's log replayed in place of its compile leaves the domain alike", {
  skip: !existsSync(generated) && "oracle/avmplus missing",
}, async () => {
  const builtin = new Uint8Array(await readFile(new URL("builtin.abc", generated)));
  const a = classes([
    { name: mn("A"), base: mn("Object"), traits: [{ name: mn("m"), kind: METHOD }] },
  ]);
  const b = classes([
    { name: mn("B"), base: mn("Object"), traits: [{ name: mn("x"), kind: SLOT, index: mn("A") }] },
  ]);
  const other = classes([
    {
      name: mn("A"),
      base: mn("Object"),
      traits: [
        { name: mn("n"), kind: METHOD },
        { name: mn("m"), kind: METHOD },
      ],
    },
  ]);
  // getlocal0, pushscope, new B().x.m(), returnvoid.
  const code = [0xd0, 0x30, 0x5d, ...u30(mn("B")), 0x4a, ...u30(mn("B")), 0];
  code.push(0x66, ...u30(mn("x")), 0x4f, ...u30(mn("m")), 0, 0x47);
  const c = abc(
    pool,
    tables({
      methods: [{}],
      scripts: [{ init: 0 }],
      bodies: [{ method: 0, code, maxStack: 2, localCount: 1, maxScopeDepth: 1 }],
    }),
  );

  const codegen = await createCodegen(module);
  // B compiled, replayed or neither: C's context and module.
  const play = (b2: "compiled" | "replayed" | "skipped", log = "") => {
    codegen.reset(50);
    codegen.add(builtin, true);
    const main = codegen.childDomain(0);
    const child = codegen.childDomain(main);
    codegen.add(a, false, child);
    codegen.add(b, false, child);
    const contextB = codegen.context(2);
    let logB: string | null = null;
    if (b2 === "compiled") {
      logB = codegen.compileModuleLogged([], 2).log;
    } else if (b2 === "replayed") {
      assert.equal(codegen.replay(log, 2), true);
    }

    codegen.add(other, false, main);
    codegen.add(c, false, child);
    return { contextB, logB, contextC: codegen.context(4), moduleC: codegen.compileModule([], 4) };
  };

  const compiled = play("compiled");
  assert.ok(compiled.logB);
  const replayed = play("replayed", compiled.logB);
  const skipped = play("skipped");
  assert.deepEqual(replayed.contextB, compiled.contextB);
  assert.deepEqual(replayed.contextC, compiled.contextC);
  assert.equal(replayed.moduleC, compiled.moduleC);
  assert.notEqual(skipped.moduleC, compiled.moduleC);
  assert.notDeepEqual(skipped.contextC, compiled.contextC);
});

test("a malformed log is refused, not a trap", async () => {
  const codegen = await createCodegen(module);
  codegen.reset(50);
  codegen.add(script([0x47]), false);
  for (const log of ["x", "2 0 9 0", "3 0 0 99", "2 7 1 0", "2 0 1", "-1 0 0 0"]) {
    assert.equal(codegen.replay(log), false, log);
  }

  assert.equal(codegen.replay(""), true);
});
