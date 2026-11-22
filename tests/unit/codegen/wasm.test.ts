import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AIR_API_VERSION, API_VERSION, createCodegen, moduleKey } from "@swf2es/codegen";
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

// Both by name from dist/, not by the package's export, which SWF2ES_COMPILER=zig redirects.
const dist = (name: string) =>
  readFile(new URL(`../../../packages/codegen/dist/${name}`, import.meta.url));
const zigModule = await WebAssembly.compile(await dist("codegen-zig.wasm"));
const asModule = await WebAssembly.compile(await dist("codegen.wasm"));

test("codegen-zig.wasm, the compiler in Zig, imports nothing but abort too", () => {
  assert.deepEqual(
    WebAssembly.Module.imports(zigModule).map((i) => `${i.module}.${i.name}`),
    ["env.abort"],
  );
});

test("createCodegen tells the compilers apart, whose identities differ so caches never mix", async () => {
  const as = await createCodegen(asModule);
  const zig = await createCodegen(zigModule);
  assert.match(zig.identity ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(zig.identity, as.identity);
  assert.deepEqual(zig.abcVersion(Uint8Array.of(16, 0, 46, 0)), { major: 46, minor: 16 });
  zig.reset();
  assert.equal(zig.add(new Uint8Array(0)), 1107);
  assert.equal(zig.revision(), as.revision());
});

test("wrapper and wasm agree on the compiler version", async () => {
  await createCodegen(module); // throws on a mismatch
});

test("the compiler is reset only at an API version ABCs run at, which keys name", async () => {
  const codegen = await createCodegen(module);
  for (const version of [-1, 52, 256 + API_VERSION, 1.5]) {
    assert.throws(() => codegen.reset(version), RangeError, `${version}`);
  }

  codegen.reset(0);
  assert.equal(codegen.apiVersion, 0);
  codegen.reset(AIR_API_VERSION);
  assert.equal(codegen.apiVersion, AIR_API_VERSION);
  codegen.reset();
  assert.equal(codegen.apiVersion, API_VERSION);
});

test("a module key names the compiler, the ABCs its domain sees and what it found", async () => {
  const codegen = await createCodegen(module);
  codegen.reset();
  // A script with a slot public::x, the first multiname of script()'s pool.
  assert.equal(codegen.add(script([0x47], {}, [{ name: 1, kind: SLOT }]), true), 0);
  const child = codegen.childDomain(0);
  assert.equal(codegen.add(script([0x47]), false, child), 0);
  const abcs = { hashes: ["a", "b"], builtins: [true, false] };
  const key = moduleKey(codegen, 1, abcs, null);
  assert.deepEqual(JSON.parse(key ?? ""), {
    compiler: codegen.identity,
    api: API_VERSION,
    abcs: ["builtin a", "b"],
    own: 1,
    libraries: null,
    blocks: "",
    log: "",
  });

  // The child's domain finding public::x, which the root defines: another key.
  codegen.found({ domain: child, nsKind: 0, uri: "", name: "x", abc: 0, asType: false });
  const found = moduleKey(codegen, 1, abcs, null);
  assert.notEqual(found, key);
  assert.match(JSON.parse(found ?? "").log, /:x$/);
});

test("a library's module key names the API version's series, a SWF's the version", async () => {
  const codegen = await createCodegen(module);
  const keys = (version: number) => {
    codegen.reset(version);
    assert.equal(codegen.add(script([0x47], {}, [{ name: 1, kind: SLOT }]), true), 0);
    assert.equal(codegen.add(script([0x47]), false, codegen.childDomain(0)), 0);
    const abcs = { hashes: ["a", "b"], builtins: [true, false] };
    return [0, 1].map((i) => JSON.parse(moduleKey(codegen, i, abcs, null) ?? "").api);
  };

  assert.deepEqual(keys(0), ["Flash Player", 0]);
  assert.deepEqual(keys(12), ["Flash Player", 12]);
  assert.deepEqual(keys(API_VERSION), ["Flash Player", API_VERSION]);
  assert.deepEqual(keys(AIR_API_VERSION), ["AIR", AIR_API_VERSION]);
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

test("memoryBytes is the size of codegen's memory, as usage tells it", async () => {
  const codegen = await createCodegen(module);
  codegen.reset();
  assert.equal(codegen.add(script([0x47])), 0);
  codegen.compileModule(["a"]);
  assert.ok(codegen.memoryBytes() > 0);
  assert.equal(codegen.memoryBytes(), codegen.usage().memory);
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
  // Each method compiled alone by the test build: its entry.
  const entries = testing.domainModuleEntries();
  assert.equal(testing.domainEmitEach([...compiled.entries.keys()].join(","), true), entries);
  assert.match(compiled.module, /7/);

  // Nothing asked for, or a body the ABC has not: nothing, not body 0 or a trap.
  assert.equal(testing.domainEmitEach("", true), "");
  assert.equal(testing.domainEmitEach("9999", true), "");

  // By index: the last is the default, an earlier one compiles against the
  // later too, and one not added is an error, not a trap.
  assert.equal(codegen.compile(["b", "a"], 1).module, compiled.module);
  assert.equal(codegen.compile(["b", "a"], 0).module, testing.domainModule("b\na", 0));
  assert.throws(() => codegen.compile(["b", "a"], 2), /only 2 have been added/);

  // The module alone is compile's, by default and by index.
  assert.equal(codegen.compileModule(["b", "a"]), compiled.module);
  assert.equal(codegen.compileModule(["b", "a"], 0), testing.domainModule("b\na", 0));
  assert.throws(() => codegen.compileModule(["b", "a"], 2), /only 2 have been added/);
});

test("a long session's compactions rebuild the domain in a new instance, whose memory holds the live ABCs", {
  skip,
}, async () => {
  // As busy content plays for hours, many SWFs loaded again and again, each
  // into a child of the main SWF's domain that goes once compiled, the host
  // compacting after each as when idle. wasm memory never shrinks, so a
  // compaction in place kept what the dead tables and the old and new took
  // together for good: in another instance, codegen's memory comes down to
  // what the live ones need, however long the session.
  const builtin = new Uint8Array(await readFile(new URL("builtin.abc", generated)));
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const codegen = await createCodegen(module);
  codegen.reset();
  assert.equal(codegen.add(builtin, true), 0);
  codegen.compileModule();
  const main = codegen.childDomain(0);
  const own = script([0x24, 7, 0x24, 5, 0xa0, 0x48]);
  assert.equal(codegen.add(own, false, main), 0);
  const compiled = codegen.compileModule(["b", "a"], 1);

  // Dead tables built up while the host has no time to compact.
  for (let n = 0; n < 100; n++) {
    const child = codegen.childDomain(main);
    assert.equal(codegen.add(builtin, true, child), 0);
    codegen.compileModule();
    codegen.dropDomain(child);
  }

  const peak = codegen.memoryBytes();
  const { dead } = codegen.usage();
  assert.ok(peak >= 32 << 20 && dead > peak / 2, `${peak} ${dead}`);
  // The first compaction finds a move due and makes the spare instance,
  // which the next takes: none is made for a compiler that never needs it.
  assert.equal(codegen.compact(), false);
  await turn();
  assert.equal(codegen.compact(), true);
  assert.ok(codegen.memoryBytes() <= peak / 4, `${codegen.memoryBytes()} of ${peak}`);
  assert.equal(codegen.usage().dead, 0);
  assert.equal(codegen.compileModule(["b", "a"], 1), compiled);

  // A long session after it: never past that peak, the main domain's ABC
  // compiling as before.
  let highest = 0;
  for (let n = 0; n < 1500; n++) {
    const child = codegen.childDomain(main);
    assert.equal(
      codegen.add(n % 10 === 0 ? builtin : script([0x24, n & 0x7f, 0x48]), n % 10 === 0, child),
      0,
    );
    codegen.compileModule();
    if (n % 7 === 0) {
      codegen.evictDomain(child);
    } else {
      codegen.dropDomain(child);
    }

    await turn();
    codegen.compact();
    highest = Math.max(highest, codegen.memoryBytes());
  }

  assert.ok(highest < peak, `${highest} of ${peak}`);
  assert.equal(codegen.compileModule(["b", "a"], 1), compiled);
});

test("a compaction never grows codegen's memory past a quarter, however large the live ABCs", {
  skip,
}, async () => {
  // A main domain of many ABCs, live for good, and as many loads again
  // into children that go, compacting after each: the tables come near
  // memory's size where the new ones no longer fit beside the old, and in
  // place such a rebuild doubled memory. Moved, or put off, memory grows
  // only as the loads grow it: a move to a new instance a little larger,
  // where memory was about to grow anyway, at most.
  const builtin = new Uint8Array(await readFile(new URL("builtin.abc", generated)));
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const codegen = await createCodegen(module);
  await turn();
  codegen.reset();
  assert.equal(codegen.add(builtin, true), 0);
  codegen.compileModule();
  const main = codegen.childDomain(0);
  for (let n = 0; n < 100; n++) {
    assert.equal(codegen.add(builtin, true, main), 0);
    codegen.compileModule();
  }

  let compactions = 0;
  for (let n = 0; n < 150; n++) {
    const child = codegen.childDomain(main);
    assert.equal(codegen.add(builtin, true, child), 0);
    codegen.compileModule();
    codegen.dropDomain(child);
    await turn();
    const before = codegen.memoryBytes();
    if (codegen.compact()) {
      compactions++;
      const after = codegen.memoryBytes();
      assert.ok(after <= before + before / 4, `load ${n}: ${before} to ${after}`);
    }
  }

  assert.ok(compactions > 0);
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

test("a module written a part at a time is the module written whole", { skip }, async () => {
  const builtin = new Uint8Array(await readFile(new URL("builtin.abc", generated)));
  const utf8 = new TextDecoder();
  // Its parts, each next one asked for until it is done, garbage collected
  // at every cut as the wrapper collects it.
  const parts = (hashes: string, index: number, keep: boolean) => {
    const got = [utf8.decode(testing.domainModuleBytes(hashes, index, keep, false))];
    while (!testing.domainModuleDone()) {
      testing.__collect();
      got.push(utf8.decode(testing.domainModuleMoreBytes()));
    }

    return got;
  };

  testing.domainReset(50);
  testing.domainAdd(builtin, true);
  testing.domainAdd(script([0x24, 7, 0x24, 5, 0xa0, 0x48]), false);
  const builtinModule = testing.domainModule("b", 0, false);
  const module = testing.domainModule("b\na");
  const sourceMap = testing.domainSourceMap();
  const entries = testing.domainModuleEntries();
  // The default budget: a small ABC in one part.
  assert.deepEqual(parts("b\na", -1, false), [module]);

  // The smallest: a part for each body verified and each entry written,
  // so that the module is cut at every place it can be.
  testing.domainPartBudget(1);
  try {
    for (const keep of [false, true]) {
      assert.equal(parts("b\na", -1, keep).join(""), module, `kept: ${keep}`);
      assert.equal(testing.domainSourceMap(), keep ? sourceMap : "");
      assert.equal(testing.domainModuleEntries(), keep ? entries : "");
    }

    const builtinParts = parts("b", 0, false);
    assert.equal(builtinParts.join(""), builtinModule);
    assert.ok(builtinParts.length > 1000, `${builtinParts.length} parts`);

    // Left as the domain changes: nothing more to hand out.
    testing.domainModuleBytes("b\na", -1, false, false);
    assert.equal(testing.domainModuleDone(), false);
    testing.domainAdd(script([0x47]), false);
    assert.equal(testing.domainModuleDone(), true);
    assert.equal(testing.domainModuleMoreBytes().length, 0);
  } finally {
    testing.domainPartBudget(0);
  }
});

test("compiling before an ABC is added is an error, not a trap", async () => {
  const codegen = await createCodegen(module);
  codegen.reset();
  assert.throws(() => codegen.compile(), /no ABC has been added/);
  assert.throws(() => codegen.compileModule(), /no ABC has been added/);
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

test("a method compiled alone is handed out as its entry's UTF-8, strings past ASCII included", () => {
  const bytes = abc(
    { strings: ["snowman ☃ and astral 🚀"] },
    tables({
      methods: [{}],
      scripts: [{ init: 0, traits: [] }],
      bodies: [
        {
          method: 0,
          code: [0x2c, 1, 0x48],
          maxStack: 1,
          localCount: 1,
          initScopeDepth: 0,
          maxScopeDepth: 0,
        },
      ],
    }),
  );
  testing.domainReset(50);
  assert.equal(testing.domainAdd(bytes, false), 0);
  const entry = testing.domainEmitEach("0", true);
  assert.match(entry, /snowman/);
  assert.equal(new TextDecoder().decode(testing.domainEmitEachBytes("0", true)), entry);
});
