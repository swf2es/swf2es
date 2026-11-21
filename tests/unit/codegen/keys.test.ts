// Module keys' log by chained digests (packages/codegen/src/keys.ts): a key
// taken as each ABC loads, reading only what the log gained, must be the
// key taken once from nothing, whatever the domains did in between, and
// name the log domainContext gives, entry for entry.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createCodegen, KeyChains, type KeyContext, type KeyLog, moduleKey } from "@swf2es/codegen";
import { classes, METHOD, mn, OVERRIDE, SLOT } from "./link-cases.ts";
import { loadTesting } from "./testing-module.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const builtin = new Uint8Array(readFileSync(new URL("builtin.abc", generated)));
const shell = new Uint8Array(readFileSync(new URL("shell_toplevel.abc", generated)));
const sorts = new Uint8Array(readFileSync(new URL("fixtures/vector-sort.abc", import.meta.url)));
const LIBRARIES = 2;

// Classes made to collide, as tests/fuzz/domains.ts's: B's slot typed A, so
// that what a domain resolved before an ancestor defines another A is
// logged, and what a domain finds of them.
const a = classes(
  [{ name: mn("A"), base: mn("Object"), traits: [{ name: mn("m"), kind: METHOD }] }],
  true,
);
const b = classes(
  [
    {
      name: mn("B"),
      base: mn("A"),
      traits: [
        { name: mn("m"), kind: METHOD, attr: OVERRIDE },
        { name: mn("x"), kind: SLOT, index: mn("A") },
      ],
    },
  ],
  true,
);
const pool = [sorts, a, b, sorts];
const decoder = new TextDecoder();

// biome-ignore lint/suspicious/noExplicitAny: the asc bindings are untyped JS
type Testing = any;

/** What KeyChains asks of the test build; without `inherit`, no domain starts from its parent's chain. */
function keyLog(t: Testing, inherit = true, read?: { bytes: number }): KeyLog {
  return {
    header: (index) => decoder.decode(t.domainKeyHeaderBytes(index)),
    parent: (appDomain) => (inherit ? t.domainParent(appDomain) : -1),
    fork: (appDomain) => t.domainKeyFork(appDomain),
    log(appDomain, after, from, to, block, filled) {
      const bytes: Uint8Array = t.domainKeyLogBytes(appDomain, after, from, to, block, filled);
      if (read) {
        read.bytes += bytes.length;
      }

      return bytes;
    },
  };
}

/** ABC `index`'s log as domainContext writes it, and as domainKeyLogBytes does with its marks left out. */
function logs(t: Testing, index: number, after: number): [string, string] {
  const context: string = t.domainContext(index, after);
  const second = context.indexOf("\n", context.indexOf("\n") + 1);
  const header = decoder.decode(t.domainKeyHeaderBytes(index)).split("\n");
  const written = decoder.decode(t.domainKeyLogBytes(Number(header[2]), after, 0, -1, 64, 0));
  return [second < 0 ? "" : context.slice(second), written.replace(/\n[#$]\d+/g, "")];
}

/** The live ABCs, by index. */
function live(t: Testing, abcDomain: number[]): number[] {
  return abcDomain.map((_, i) => i).filter((i) => t.domainState(abcDomain[i]) === 0);
}

/** A domain as the player keeps one: the libraries in the root, compiled, and the main movie's domain below. */
async function start(): Promise<{ t: Testing; abcDomain: number[]; main: number }> {
  const t = await loadTesting(process.env.SWF2ES_CHECKED ? "dist-test-checked" : "dist-test");
  t.domainReset(50);
  const abcDomain: number[] = [];
  for (const library of [builtin, shell]) {
    assert.equal(t.domainAdd(library, true, 0), 0);
    abcDomain.push(0);
    t.domainModule("", abcDomain.length - 1, false);
  }

  return { t, abcDomain, main: t.domainChild(0) };
}

/** Every live ABC's key context, taken by `chains` and from nothing, alike, and naming domainContext's log. */
function check(t: Testing, chains: KeyChains, abcDomain: number[], what: string): void {
  for (const i of live(t, abcDomain)) {
    for (const after of [0, LIBRARIES]) {
      const kept = chains.context(i, after);
      const fresh = new KeyChains(keyLog(t)).context(i, after);
      const alone = new KeyChains(keyLog(t, false)).context(i, after);
      assert.ok(kept, `${what}: ABC ${i} has a context`);
      assert.deepEqual(kept, fresh, `${what}: ABC ${i} after ${after}, kept and fresh`);
      assert.deepEqual(kept, alone, `${what}: ABC ${i} after ${after}, kept and alone`);
      const [context, written] = logs(t, i, after);
      assert.equal(written, context, `${what}: ABC ${i} after ${after}, the log`);
    }
  }
}

test("a key taken at each load is the key taken once, in one domain and in its children", async () => {
  const { t, abcDomain, main } = await start();
  const chains = new KeyChains(keyLog(t));
  const add = (abc: Uint8Array, domain: number) => {
    assert.equal(t.domainAdd(abc, false, domain), 0);
    abcDomain.push(domain);
    return abcDomain.length - 1;
  };

  // Enough loads into the main movie's domain for its log to fill blocks,
  // children of it between, and a grandchild.
  let blocks = 0;
  for (let k = 0; k < 24; k++) {
    const domain = k % 3 === 2 ? t.domainChild(k % 2 ? main : abcDomain.at(-1)) : main;
    const index = add(pool[k % pool.length], domain);
    const context = chains.context(index, LIBRARIES) as KeyContext;
    blocks += context.blocks === "" ? 0 : 1;
    t.domainModule("", index, false);
    check(t, chains, abcDomain, `load ${k}`);
  }

  assert.ok(blocks > 0, "the log fills blocks");
});

test("a child's key reads only what its parent's chain has not", async () => {
  const { t, abcDomain, main } = await start();
  const read = { bytes: 0 };
  const chains = new KeyChains(keyLog(t, true, read));
  for (let k = 0; k < 12; k++) {
    assert.equal(t.domainAdd(pool[k % pool.length], false, main), 0);
    abcDomain.push(main);
    chains.context(abcDomain.length - 1, LIBRARIES);
    t.domainModule("", abcDomain.length - 1, false);
  }

  chains.context(abcDomain.length - 1, LIBRARIES);
  const child = t.domainChild(main);
  assert.equal(t.domainAdd(sorts, false, child), 0);
  abcDomain.push(child);
  read.bytes = 0;
  const kept = chains.context(abcDomain.length - 1, LIBRARIES);
  const whole = keyLog(t);
  const alone = new KeyChains({ ...whole, parent: () => -1 });
  const counted = { bytes: 0 };
  const scratch = new KeyChains(keyLog(t, false, counted));
  assert.deepEqual(kept, alone.context(abcDomain.length - 1, LIBRARIES));
  scratch.context(abcDomain.length - 1, LIBRARIES);
  assert.ok(
    read.bytes * 8 < counted.bytes,
    `the child read ${read.bytes} bytes, from nothing ${counted.bytes}`,
  );
});

test("a finding, a drop, an eviction and a rebuild leave keys as taken from nothing", async () => {
  const { t, abcDomain, main } = await start();
  const chains = new KeyChains(keyLog(t));
  const bytes: Uint8Array[] = [builtin, shell];
  const add = (abc: Uint8Array, domain: number) => {
    assert.equal(t.domainAdd(abc, false, domain), 0);
    abcDomain.push(domain);
    bytes.push(abc);
    t.domainModule("", abcDomain.length - 1, false);
    return abcDomain.length - 1;
  };

  const child = t.domainChild(main);
  const other = t.domainChild(main);
  const index = add(a, child);
  add(b, child);
  add(sorts, other);
  check(t, chains, abcDomain, "loaded");

  // The child finds the A it defines, then the main movie's domain gets an A of its own.
  t.domainFound(child, 0, "", "A", index, true);
  add(a, main);
  add(b, main);
  check(t, chains, abcDomain, "found");

  // A grandchild below the finding, which its parent's chain cannot start.
  const grandchild = t.domainChild(child);
  add(sorts, grandchild);
  check(t, chains, abcDomain, "below a finding");

  t.domainDrop(other);
  chains.forget((d) => t.domainState(d) === 2);
  add(sorts, main);
  check(t, chains, abcDomain, "dropped");

  t.domainEvict(child);
  add(sorts, main);
  check(t, chains, abcDomain, "evicted");
  assert.ok(t.domainRebuild());
  check(t, chains, abcDomain, "rebuilt");
  // The rebuild let go of the evicted ABCs' bytes, given again.
  assert.equal(t.domainRevive(child), -1);
  for (const i of abcDomain.keys()) {
    if (t.domainState(abcDomain[i]) === 1) {
      assert.equal(t.domainRestore(i, bytes[i]), 0);
    }
  }

  assert.equal(t.domainRevive(child), 1);
  add(sorts, child);
  check(t, chains, abcDomain, "revived");
});

test("keys taken as the player takes them, at each load, are the keys taken once at the end", async () => {
  const module = await WebAssembly.compile(
    readFileSync(new URL(import.meta.resolve("@swf2es/codegen/codegen.wasm"))),
  );
  const player = await createCodegen(module);
  const command = await createCodegen(module);
  const hashes: string[] = [];
  const builtins: boolean[] = [];
  for (const codegen of [player, command]) {
    codegen.reset();
    codegen.add(builtin, true);
    codegen.add(shell, true);
  }

  hashes.push("builtin", "shell");
  builtins.push(true, true);
  const libraries = { count: LIBRARIES, digest: "libraries" };
  const keys = (codegen: typeof player, upTo: number) =>
    hashes
      .slice(0, upTo)
      .map((_, i) => moduleKey(codegen, i, { hashes, builtins }, i < LIBRARIES ? null : libraries));

  // The player keys each ABC as it loads, and the others now and then; the
  // command, once the SWF's are all added, each in order before it compiles.
  const main = player.childDomain(0);
  assert.equal(command.childDomain(0), main);
  for (let k = 0; k < 20; k++) {
    const domain = k % 4 === 3 ? player.childDomain(main) : main;
    if (domain !== main) {
      assert.equal(command.childDomain(main), domain);
    }

    for (const codegen of [player, command]) {
      assert.equal(codegen.add(pool[k % pool.length], false, domain), 0);
    }

    hashes.push(`h${k}`);
    builtins.push(false);
    keys(player, hashes.length);
    player.compileModuleLogged(hashes, hashes.length - 1);
    command.compileModuleLogged(hashes, hashes.length - 1);
  }

  assert.deepEqual(keys(player, hashes.length), keys(command, hashes.length));
});

/** A key context without the indices of the ABCs it names, which ABCs added elsewhere move. */
const placed = (context: KeyContext | null) => context && { ...context, abcs: context.abcs.length };

test("a domain's keys do not depend on ABCs added where it does not see", async () => {
  // A SWF's ABCs all added to the main movie's domain, then each keyed and
  // compiled in turn; in one of the two, an ABC added to a sibling of the
  // domain before the last is keyed, which settles nothing it sees.
  const keys: ReturnType<typeof placed>[][] = [];
  for (const elsewhere of [false, true]) {
    const { t, abcDomain, main } = await start();
    const sibling = t.domainChild(0);
    const chains = new KeyChains(keyLog(t));
    const first = abcDomain.length;
    for (let k = 0; k < 30; k++) {
      assert.equal(t.domainAdd(pool[k % pool.length], false, main), 0);
      abcDomain.push(main);
    }

    const taken: ReturnType<typeof placed>[] = [];
    for (let k = 0; k < 30; k++) {
      if (elsewhere && k === 29) {
        assert.equal(t.domainAdd(sorts, false, sibling), 0);
      }

      taken.push(placed(chains.context(first + k, LIBRARIES)));
      taken.push(placed(new KeyChains(keyLog(t, false)).context(first + k, LIBRARIES)));
      t.domainModule("", first + k, false);
    }

    keys.push(taken);
  }

  assert.ok(
    keys[0].some((c) => c?.rest),
    "entries go unsettled",
  );
  assert.deepEqual(keys[1], keys[0]);
});

test("keys taken between the parts of a module, and after it is abandoned, are those from nothing", async () => {
  const { t, abcDomain, main } = await start();
  const chains = new KeyChains(keyLog(t));
  for (let k = 0; k < 8; k++) {
    assert.equal(t.domainAdd(pool[k % pool.length], false, main), 0);
    abcDomain.push(main);
    t.domainModule("", abcDomain.length - 1, false);
  }

  check(t, chains, abcDomain, "loaded");
  t.domainPartBudget(256);
  try {
    for (const abandon of [false, true]) {
      assert.equal(t.domainAdd(sorts, false, main), 0);
      abcDomain.push(main);
      t.domainModuleBytes("", abcDomain.length - 1, false, false);
      let parts = 1;
      while (!t.domainModuleDone()) {
        check(t, chains, abcDomain, `part ${parts}`);
        if (abandon && parts === 2) {
          // A finding abandons the module, which keeps what it logged so far.
          t.domainFound(main, 0, "", "A", abcDomain.indexOf(main) + 1, true);
          check(t, chains, abcDomain, "abandoned");
          break;
        }

        t.domainModuleMoreBytes();
        parts++;
      }

      assert.ok(parts > 1, "the module comes in parts");
      check(t, chains, abcDomain, abandon ? "after abandoning" : "done");
    }
  } finally {
    t.domainPartBudget(0);
  }
});

test("a finding of a child with no ABC yet keys its children apart from their grandparent", async () => {
  const { t, abcDomain, main } = await start();
  const chains = new KeyChains(keyLog(t));
  const add = (abc: Uint8Array, domain: number) => {
    assert.equal(t.domainAdd(abc, false, domain), 0);
    abcDomain.push(domain);
    t.domainModule("", abcDomain.length - 1, false);
    return abcDomain.length - 1;
  };

  for (let k = 0; k < 6; k++) {
    add(pool[k % pool.length], main);
  }

  const definesA = add(a, main);
  check(t, chains, abcDomain, "loaded");
  const child = t.domainChild(main);
  t.domainFound(child, 0, "", "A", definesA, true);
  add(sorts, t.domainChild(child));
  check(t, chains, abcDomain, "below the finding");
  add(b, child);
  check(t, chains, abcDomain, "the child's own");
});

test("an ABC of a domain not live has no key, and its domain keeps no chain", async () => {
  const { t, abcDomain, main } = await start();
  const chains = new KeyChains(keyLog(t));
  // Below the main movie's domain, which holds no ABC: the evicted domain's live ancestors none but the root's.
  const evicted = t.domainChild(main);
  const dropped = t.domainChild(main);
  for (const domain of [evicted, dropped]) {
    assert.equal(t.domainAdd(sorts, false, domain), 0);
    abcDomain.push(domain);
    assert.ok(chains.context(abcDomain.length - 1, LIBRARIES));
  }

  t.domainEvict(evicted);
  t.domainDrop(dropped);
  for (const index of [abcDomain.length - 2, abcDomain.length - 1]) {
    assert.equal(t.domainKeyHeaderBytes(index).length, 0);
    assert.equal(chains.context(index, LIBRARIES), null);
    assert.equal(new KeyChains(keyLog(t)).context(index, LIBRARIES), null);
  }
});

test("a domain whose chain a child took past its settled entries keys as from nothing, again", async () => {
  const { t, abcDomain, main } = await start();
  const read = { bytes: 0 };
  const chains = new KeyChains(keyLog(t, true, read));
  // A SWF's ABCs added, then compiled: what they log is past the entries the
  // main movie's domain settled, until it gains an ABC.
  const first = abcDomain.length;
  for (let k = 0; k < 40; k++) {
    assert.equal(t.domainAdd(pool[k % pool.length], false, main), 0);
    abcDomain.push(main);
  }

  for (let k = 0; k < 40; k++) {
    chains.context(first + k, LIBRARIES);
    t.domainModule("", first + k, false);
  }

  // A child's start takes the main movie's domain's chain through all of it.
  const child = t.domainChild(main);
  assert.equal(t.domainAdd(sorts, false, child), 0);
  abcDomain.push(child);
  chains.context(abcDomain.length - 1, LIBRARIES);

  const last = first + 39;
  const reads: number[] = [];
  for (let k = 0; k < 2; k++) {
    read.bytes = 0;
    const kept = chains.context(last, LIBRARIES);
    reads.push(read.bytes);
    assert.deepEqual(kept, new KeyChains(keyLog(t, false)).context(last, LIBRARIES));
  }

  assert.ok(reads[1] <= reads[0], `read ${reads[0]} bytes, then ${reads[1]}`);
});
