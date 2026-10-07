import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { abc, tables, u30 } from "./abc-builder.ts";
import {
  classes,
  GETTER,
  linkCases,
  METHOD,
  mn,
  OVERRIDE,
  resolveCases,
  SETTER,
  SLOT,
} from "./link-cases.ts";
import { testing } from "./testing-module.ts";

const NS_PUBLIC = 0;
const SWF_31 = 50;
const VM_INTERNAL = 52;
const mark = (version: number) => String.fromCharCode(0xe294 + version);

/** An ABC whose script defines a slot for each of `names`, as [URI, name]. */
function definitions(names: [string, string][], kind = 0x16): Uint8Array {
  const strings = names.flat();
  const pool = {
    strings,
    namespaces: names.map((_, i) => [kind, ...u30(2 * i + 1)]),
    multinames: names.map((_, i) => [0x07, ...u30(i + 1), ...u30(2 * i + 2)]),
  };
  const traits = names.map((_, i) => ({ name: i + 1, kind: 0 }));
  return abc(pool, tables({ methods: [{}], scripts: [{ init: 0, traits }] }));
}

const find = (uri: string, name: string, version = SWF_31) =>
  testing.domainFind(NS_PUBLIC, uri, name, version) as string;

test("names are interned across ABCs, and the first definition wins", () => {
  testing.domainReset(SWF_31);
  assert.equal(testing.domainAdd(definitions([["p", "a"]]), false), 0);
  assert.equal(
    testing.domainAdd(
      definitions([
        ["q", "b"],
        ["p", "a"],
      ]),
      false,
    ),
    0,
  );
  assert.equal(find("p", "a"), "abc 0 script 0 trait 0");
  assert.equal(find("q", "b"), "abc 1 script 0 trait 0");
  assert.equal(find("q", "a"), "none");
  assert.match(testing.domainSummary() as string, /^strings 4 namespaces 2 bindings 3 /);
});

test("application domains see their chain's names, from the root down, and what they found", () => {
  testing.domainReset(SWF_31);
  const at = (d: number, uri: string, name: string) =>
    testing.domainFind(NS_PUBLIC, uri, name, SWF_31, d) as string;
  assert.equal(testing.domainAdd(definitions([["p", "a"]]), false), 0);
  const child = testing.domainChild(0) as number;
  const sibling = testing.domainChild(0) as number;
  assert.equal(
    testing.domainAdd(
      definitions([
        ["p", "b"],
        ["p", "c"],
      ]),
      false,
      child,
    ),
    0,
  );
  assert.equal(testing.domainAdd(definitions([["p", "b"]]), false, sibling), 0);
  assert.equal(at(child, "p", "a"), "abc 0 script 0 trait 0");
  assert.equal(at(child, "p", "b"), "abc 1 script 0 trait 0");
  assert.equal(at(sibling, "p", "b"), "abc 2 script 0 trait 0");
  assert.equal(at(0, "p", "b"), "none");

  // The root defines b too: each child finds the root's, first from the
  // root down, until the runtime reports that one has found its own.
  assert.equal(testing.domainAdd(definitions([["p", "b"]]), false), 0);
  assert.equal(at(child, "p", "b"), "abc 3 script 0 trait 0");
  testing.domainFound(child, NS_PUBLIC, "p", "b", 1, false);
  assert.equal(at(child, "p", "b"), "abc 1 script 0 trait 0");
  // Reported again, as the runtime does for each ABC the domain loads, it is kept once.
  testing.domainFound(child, NS_PUBLIC, "p", "b", 1, false);
  assert.match(testing.domainSummary() as string, / found 1 /);
  assert.equal(at(sibling, "p", "b"), "abc 3 script 0 trait 0");
  assert.equal(at(child, "p", "c"), "abc 1 script 0 trait 1");

  // A module is compiled after the ABCs its domain sees, in load order.
  assert.equal(testing.domainAdd(definitions([["p", "d"]]), false, child), 0);
  assert.match(
    testing.domainModule("h0\nh1\nh2\nh3\nh4") as string,
    /linked: \["h0", "h1", "h3"\]/,
  );
});

test("a dropped application domain is seen no more, and later ABCs keep their indices", () => {
  testing.domainReset(SWF_31);
  const at = (d: number, uri: string, name: string) =>
    testing.domainFind(NS_PUBLIC, uri, name, SWF_31, d) as string;
  assert.equal(testing.domainAdd(definitions([["p", "a"]]), false), 0);
  const child = testing.domainChild(0) as number;
  const grandchild = testing.domainChild(child) as number;
  const sibling = testing.domainChild(0) as number;
  assert.equal(
    testing.domainAdd(
      definitions([
        ["p", "b"],
        ["p", "c"],
      ]),
      false,
      child,
    ),
    0,
  );
  assert.equal(testing.domainAdd(definitions([["p", "d"]]), false, grandchild), 0);
  assert.equal(testing.domainAdd(definitions([["p", "b"]]), false, sibling), 0);
  const hashes = "h0\nh1\nh2\nh3";
  const module = testing.domainModule(hashes, 3) as string;
  assert.match(module, /linked: \["h0"\]/);
  assert.match(testing.domainSummary() as string, /^strings 5 namespaces 1 bindings 5 /);

  // The child and its descendants: they take no more ABCs or children,
  // and their ABCs compile no more.
  testing.domainDrop(child);
  assert.equal(testing.domainChild(child), -1);
  assert.equal(testing.domainChild(grandchild), -1);
  assert.equal(testing.domainAdd(definitions([["p", "e"]]), false, grandchild), -1);
  assert.equal(testing.domainModule(hashes, 1), "");
  assert.equal(testing.domainModule(hashes, 2), "");
  assert.equal(at(sibling, "p", "b"), "abc 3 script 0 trait 0");

  // Rebuilt without them: a name only they spelled is gone, one the
  // sibling spells too stays, and the sibling's ABC compiles as it did.
  assert.equal(testing.domainCompact(), true);
  assert.match(testing.domainSummary() as string, /^strings 3 namespaces 1 bindings 2 /);
  assert.equal(at(sibling, "p", "b"), "abc 3 script 0 trait 0");
  assert.equal(at(sibling, "p", "a"), "abc 0 script 0 trait 0");
  assert.equal(testing.domainModule(hashes, 3), module);
  assert.equal(testing.domainModule(hashes, 1), "");

  // The next ABC is the fifth, in a domain numbered after the dropped.
  const next = testing.domainChild(0) as number;
  assert.equal(next, 4);
  assert.equal(testing.domainAdd(definitions([["p", "c"]]), false, next), 0);
  assert.equal(at(next, "p", "c"), "abc 4 script 0 trait 0");
  assert.equal(testing.domainCompact(), false);

  // The root is never dropped, nor a domain never made.
  testing.domainDrop(0);
  testing.domainDrop(99);
  testing.domainDrop(-1);
  assert.equal(at(0, "p", "a"), "abc 0 script 0 trait 0");
});

test("what a live domain found holds after a rebuild, and a dropped one's is gone", () => {
  testing.domainReset(SWF_31);
  const at = (d: number, uri: string, name: string) =>
    testing.domainFind(NS_PUBLIC, uri, name, SWF_31, d) as string;
  assert.equal(testing.domainAdd(definitions([["p", "a"]]), false), 0);
  const child = testing.domainChild(0) as number;
  const other = testing.domainChild(0) as number;
  assert.equal(testing.domainAdd(definitions([["p", "b"]]), false, child), 0);
  // Large enough, against the live ABCs, for a rebuild to be worth it.
  const many = ["x", "y", "z", "w", "v"].map((name): [string, string] => ["p", name]);
  assert.equal(testing.domainAdd(definitions(many), false, other), 0);
  assert.equal(testing.domainAdd(definitions([["p", "b"]]), false), 0);
  testing.domainFound(child, NS_PUBLIC, "p", "b", 1, false);
  testing.domainFound(other, NS_PUBLIC, "p", "x", 2, false);
  assert.equal(at(child, "p", "b"), "abc 1 script 0 trait 0");
  assert.match(testing.domainSummary() as string, / found 2 /);

  testing.domainDrop(other);
  // Found in a dropped domain, or of a dropped domain's ABC: not recorded.
  testing.domainFound(other, NS_PUBLIC, "p", "x", 2, false);
  testing.domainFound(child, NS_PUBLIC, "p", "x", 2, false);
  assert.equal(testing.domainCompact(), true);
  assert.match(testing.domainSummary() as string, / found 1 /);
  assert.equal(at(child, "p", "b"), "abc 1 script 0 trait 0");
  assert.equal(at(0, "p", "b"), "abc 3 script 0 trait 0");
});

test("an evicted domain is revived as it was, given its ABCs again once a rebuild let them go", () => {
  testing.domainReset(SWF_31);
  const at = (d: number, uri: string, name: string) =>
    testing.domainFind(NS_PUBLIC, uri, name, SWF_31, d) as string;
  assert.equal(testing.domainAdd(definitions([["p", "a"]]), false), 0);
  const child = testing.domainChild(0) as number;
  const grandchild = testing.domainChild(child) as number;
  const many = ["b", "c", "d", "e", "f"].map((name): [string, string] => ["p", name]);
  const childAbc = definitions(many);
  const grandchildAbc = definitions([["p", "g"]]);
  assert.equal(testing.domainAdd(childAbc, false, child), 0);
  assert.equal(testing.domainAdd(grandchildAbc, false, grandchild), 0);
  // The root defines b after the child did; the child found its own.
  assert.equal(testing.domainAdd(definitions([["p", "b"]]), false), 0);
  testing.domainFound(child, NS_PUBLIC, "p", "b", 1, false);
  const hashes = "h0\nh1\nh2\nh3";
  const module = testing.domainModule(hashes, 2) as string;

  // Evicted with its descendants, as dropped; revived before a rebuild,
  // it is as it was, and its descendants stay evicted until revived too.
  testing.domainEvict(child);
  assert.deepEqual([testing.domainState(child), testing.domainState(grandchild)], [1, 1]);
  assert.equal(testing.domainChild(child), -1);
  assert.equal(at(child, "p", "c"), "none");
  assert.equal(testing.domainRevive(grandchild), -1);
  assert.equal(testing.domainRevive(child), 0);
  assert.deepEqual([testing.domainState(child), testing.domainState(grandchild)], [0, 1]);
  assert.equal(at(child, "p", "c"), "abc 1 script 0 trait 1");
  assert.equal(at(child, "p", "b"), "abc 1 script 0 trait 0");
  assert.equal(testing.domainRevive(grandchild), 0);

  // Let go of by a rebuild, they are revived only given their ABCs again,
  // and link as they did, what they found with them.
  testing.domainEvict(child);
  assert.equal(testing.domainCompact(), true);
  assert.match(testing.domainSummary() as string, / found 0 /);
  assert.equal(testing.domainRevive(child), -1);
  assert.equal(testing.domainRestore(0, childAbc), -1);
  assert.equal(testing.domainRestore(1, new Uint8Array([16, 0, 46, 0])), 1107);
  assert.equal(testing.domainRestore(1, childAbc), 0);
  assert.equal(testing.domainRevive(child), 1);
  assert.equal(at(child, "p", "c"), "abc 1 script 0 trait 1");
  assert.equal(at(child, "p", "b"), "abc 1 script 0 trait 0");
  assert.match(testing.domainSummary() as string, / found 1 /);
  assert.equal(testing.domainRevive(grandchild), -1);
  assert.equal(testing.domainRestore(2, grandchildAbc), 0);
  assert.equal(testing.domainRevive(grandchild), 1);
  assert.equal(testing.domainModule(hashes, 2), module);

  // Dropped while evicted, it is gone for good.
  testing.domainEvict(child);
  testing.domainDrop(child);
  assert.deepEqual([testing.domainState(child), testing.domainState(grandchild)], [2, 2]);
  assert.equal(testing.domainRestore(1, childAbc), -1);
  assert.equal(testing.domainRevive(child), -1);
  assert.equal(testing.domainState(99), -1);
});

test("an ABC that does not parse is not added", () => {
  testing.domainReset(SWF_31);
  assert.equal(testing.domainAdd(abc({}, tables({ methods: [{ flags: 0x20 }] })), false), 1079);
  assert.match(testing.domainSummary() as string, /^strings 0 namespaces 0 bindings 0 /);
});

test("a builtin ABC's version marks are stripped and set the binding's version", () => {
  testing.domainReset(SWF_31);
  const builtin = definitions([
    [`p${mark(12)}`, "since12"],
    ["p", "internal"],
    ["other", "all"],
  ]);
  assert.equal(testing.domainAdd(builtin, true), 0);
  assert.equal(find("p", "since12", 12), "abc 0 script 0 trait 0");
  assert.equal(find("p", "since12", 10), "none");
  // A public name in a URI that has marks elsewhere, but not here, is VM-internal.
  assert.equal(find("p", "internal"), "none");
  assert.equal(find("p", "internal", VM_INTERNAL), "abc 0 script 0 trait 1");
  assert.equal(find("other", "all", 0), "abc 0 script 0 trait 2");
  assert.match(testing.domainSummary() as string, / versioned p$/);
});

test("user ABCs' marks are stripped, but their public names get the domain's version", () => {
  testing.domainReset(SWF_31);
  assert.equal(testing.domainAdd(definitions([[`p${mark(12)}`, "a"]]), false), 0);
  assert.equal(find("p", "a"), "abc 0 script 0 trait 0");
  assert.equal(find("p", "a", SWF_31 - 2), "none");
});

// avmshell's own API versioning fixtures, from the avmplus submodule. The
// expected visibility is what Tamarin's versioning/globals.as expects at
// FP_10_0 and FP_10_0_32, and what avmshell prints at its default, SWF_31.
const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
test("names are visible as avmshell's versioning tests expect", {
  skip: !existsSync(generated) && "oracle/avmplus missing",
}, () => {
  testing.domainReset(SWF_31);
  for (const name of ["builtin", "shell_toplevel"]) {
    const bytes = new Uint8Array(readFileSync(new URL(`${name}.abc`, generated)));
    assert.equal(testing.domainAdd(bytes, true), 0, name);
  }

  const visible = (name: string) =>
    [2, 5, SWF_31].map((v) => (find("avmshell", name, v) === "none" ? "-" : "+")).join("");
  assert.deepEqual(
    Object.fromEntries(
      [
        "public_var",
        "public_var_AIR_1_0",
        "public_var_FP_10_0",
        "public_var_AIR_1_5",
        "public_var_AIR_1_5_1",
        "public_var_FP_10_0_32",
        "public_var_AIR_1_5_2",
        "public_var_AIR_1_0_FP_10_0",
        "public_var_AIR_1_5_1_FP_10_0_AIR_1_5_2",
        "public_var_FP_10_0_32_AIR_1_0_FP_10_0",
      ].map((n) => [n, visible(n)]),
    ),
    {
      public_var: "+++",
      public_var_AIR_1_0: "---",
      public_var_FP_10_0: "+++",
      public_var_AIR_1_5: "---",
      public_var_AIR_1_5_1: "---",
      public_var_FP_10_0_32: "-++",
      public_var_AIR_1_5_2: "---",
      public_var_AIR_1_0_FP_10_0: "+++",
      public_var_AIR_1_5_1_FP_10_0_AIR_1_5_2: "+++",
      public_var_FP_10_0_32_AIR_1_0_FP_10_0: "+++",
    },
  );
  assert.notEqual(find("", "Object"), "none");
  assert.notEqual(find("__AS3__.vec", "Vector"), "none");
});

test("classes link to their bases and interfaces as avmplus links them", {
  skip: !existsSync(generated) && "oracle/avmplus missing",
}, () => {
  const builtin = new Uint8Array(readFileSync(new URL("builtin.abc", generated)));
  for (const c of linkCases) {
    testing.domainReset(SWF_31);
    assert.equal(testing.domainAdd(builtin, true), 0);
    assert.equal(testing.domainAdd(c.abc, false), c.error ?? 0, c.name);
  }
});

test("members bind to slot and dispatch ids after their base's", {
  skip: !existsSync(generated) && "oracle/avmplus missing",
}, () => {
  testing.domainReset(SWF_31);
  testing.domainAdd(new Uint8Array(readFileSync(new URL("builtin.abc", generated))), true);
  const first = testing.domainTraitsCount() as number;
  const layered = classes([
    {
      name: mn("A"),
      base: mn("Object"),
      traits: [
        { name: mn("m"), kind: METHOD },
        { name: mn("x"), kind: GETTER },
        { name: mn("x"), kind: SETTER },
        { name: mn("prototype"), kind: SLOT },
      ],
    },
    {
      name: mn("B"),
      base: mn("A"),
      traits: [
        { name: mn("m"), kind: METHOD, attr: OVERRIDE },
        { name: mn("F"), kind: METHOD },
        { name: mn("I"), kind: SLOT },
      ],
    },
  ]);
  assert.equal(testing.domainAdd(layered, false), 0);

  // Object's instances have 3 methods; kinds: 1 method, 2 var, 7 get and set.
  const lines = (testing.domainTraits(first) as string).split("\n");
  assert.deepEqual(lines.slice(0, 9), [
    `traits ${first} kind 1 base 0 slots 1 methods 6`,
    "  ::m 1 3",
    "  ::x 7 4",
    "  ::prototype 2 0",
    `traits ${first + 1} kind 1 base ${first} slots 2 methods 7`,
    "  ::m 1 3",
    "  ::F 1 6",
    "  ::I 2 1",
    `traits ${first + 2} kind 2 base 1 slots 0 methods 5`,
  ]);
});

test("classes resolve their types as avmplus resolves them when created", {
  skip: !existsSync(generated) && "oracle/avmplus missing",
}, () => {
  const builtin = new Uint8Array(readFileSync(new URL("builtin.abc", generated)));
  for (const c of resolveCases) {
    testing.domainReset(SWF_31);
    assert.equal(testing.domainAdd(builtin, true), 0);
    const first = testing.domainTraitsCount() as number;
    const error =
      (testing.domainAdd(c.abc, false) as number) || (testing.domainResolve(first) as number);
    assert.equal(error, c.error ?? 0, c.name);
  }
});

test("the first builtin ABC supplies the builtin types", {
  skip: !existsSync(generated) && "oracle/avmplus missing",
}, () => {
  testing.domainReset(SWF_31);
  testing.domainAdd(new Uint8Array(readFileSync(new URL("builtin.abc", generated))), true);
  const found = (testing.domainBuiltins() as string).split(" ");
  for (let i = 0; i < found.length; i += 2) {
    assert.ok(Number(found[i + 1]) >= 0, `${found[i]} not found`);
  }
});

test("collecting garbage between calls keeps the domain and frees what was dropped", {
  skip: !existsSync(generated) && "oracle/avmplus missing",
}, () => {
  const builtin = new Uint8Array(readFileSync(new URL("builtin.abc", generated)));
  testing.domainReset(SWF_31);
  testing.domainAdd(builtin, true);
  testing.__collect();
  assert.notEqual(find("", "Object"), "none");
  assert.match(testing.domainVerifyAll() as string, /^verified 630 of 630 bodies$/);

  // Domains dropped by domainReset are freed, so memory stops growing.
  for (let i = 0; i < 50; i++) {
    testing.domainReset(SWF_31);
    testing.domainAdd(builtin, true);
    testing.domainVerifyAll();
    testing.__collect();
  }

  const size = testing.memory.buffer.byteLength;
  for (let i = 0; i < 50; i++) {
    testing.domainReset(SWF_31);
    testing.domainAdd(builtin, true);
    testing.domainVerifyAll();
    testing.__collect();
  }

  assert.equal(testing.memory.buffer.byteLength, size);
});

test("dropping other domains changes no module, and memory stops growing", {
  skip: !existsSync(generated) && "oracle/avmplus missing",
}, () => {
  const builtin = new Uint8Array(readFileSync(new URL("builtin.abc", generated)));
  const layered = (n: number) =>
    classes(
      [
        {
          name: mn("A"),
          base: mn("Object"),
          traits: [
            { name: mn("m"), kind: METHOD },
            { name: mn("x"), kind: GETTER },
          ],
        },
        {
          name: mn("B"),
          base: mn("A"),
          traits: [
            { name: mn("m"), kind: METHOD, attr: OVERRIDE },
            ...(n % 2 ? [{ name: mn("F"), kind: METHOD }] : []),
          ],
        },
      ],
      true,
    );
  testing.domainReset(SWF_31);
  testing.domainAdd(builtin, true);
  const domain = testing.domainChild(0) as number;
  assert.equal(testing.domainAdd(layered(0), false, domain), 0);
  const module = testing.domainModule("b\nx", 1) as string;

  // Each other domain loads the same names, compiles and is dropped.
  let size = 0;
  for (let n = 1; n <= 1000; n++) {
    const other = testing.domainChild(0) as number;
    assert.equal(testing.domainAdd(layered(n), false, other), 0);
    assert.notEqual(testing.domainModule("", -1, false), "");
    testing.domainDrop(other);
    if (testing.domainCompact()) {
      testing.__collect();
    }

    if (n === 250) {
      size = testing.memory.buffer.byteLength;
    }
  }

  assert.equal(testing.memory.buffer.byteLength, size);
  assert.equal(testing.domainModule("b\nx", 1), module);

  // As compiled in a domain that never had the others.
  testing.domainReset(SWF_31);
  testing.domainAdd(builtin, true);
  testing.domainAdd(layered(0), false, testing.domainChild(0));
  assert.equal(testing.domainModule("b\nx", 1), module);
});
