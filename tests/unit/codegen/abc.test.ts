import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { abc, type Instance, type Tables, type Trait, tables, u30 } from "./abc-builder.ts";
import { testing } from "./testing-module.ts";

const SLOT = 0;
const METHOD = 1;
const CLASS = 4;
const FUNCTION = 5;

// Multinames: 1 a, 2 b, 3 Obj (QNames), 4 Multiname a, 5 QNameA a,
// 6 a in any namespace, 7 TypeName Obj.<a>.
const pool = {
  strings: ["a", "b", "Obj"],
  namespaces: [[0x16, ...u30(0)]],
  nsSets: [[1]],
  multinames: [
    [0x07, ...u30(1), ...u30(1)],
    [0x07, ...u30(1), ...u30(2)],
    [0x07, ...u30(1), ...u30(3)],
    [0x09, ...u30(1), ...u30(1)],
    [0x0d, ...u30(1), ...u30(1)],
    [0x07, ...u30(0), ...u30(1)],
    [0x1d, ...u30(3), ...u30(1), ...u30(1)],
  ],
};

const dump = (t: Tables): string[] =>
  (testing.abcDump(abc(pool, tables(t))) as string).split("\n").filter(Boolean);
const error = (t: Tables): string | undefined => dump(t).find((l) => l.startsWith("error"));
const methods = (n: number) => Array.from({ length: n }, () => ({}));
const scriptWith = (traits: Trait[], methodCount = 2): Tables => ({
  methods: methods(methodCount),
  scripts: [{ init: 0, traits }],
});

test("parses the tables ASC 2.0 wrote for vector-sort.as", async () => {
  const bytes = await readFile(new URL("fixtures/vector-sort.abc", import.meta.url));
  // As abcdump: script0$init():* is method 0 and the script's init, the
  // anonymous function(int,int):int is method 1, var v is a slot of type
  // Vector.<int> (multiname 2).
  assert.deepEqual((testing.abcDump(new Uint8Array(bytes)) as string).split("\n"), [
    "method 0 ret=0 params= name=0 flags=0x00",
    "method 1 ret=4 params=4,4 name=6 flags=0x00",
    "script 0 init=0",
    "  trait script 0 name=1 kind=0 attr=0x00 id=0 index=2",
    // abcdump: local_count=3 max_scope=0 max_stack=2 code_len=4 code_offset=188
    "body 0 method=1 stack=2 locals=3 scope=0..0 code=188+4",
    // abcdump: local_count=1 max_scope=1 max_stack=7 code_len=67 code_offset=200
    "body 1 method=0 stack=7 locals=1 scope=0..1 code=200+67",
    "bound method 0 to script 0",
  ]);
});

test("methods: parameters, optional values and skipped parameter names", () => {
  const lines = dump({
    methods: [{ params: [1, 2], ret: 3, name: 1, optional: [[1, 0x03]], paramNames: [1, 2] }, {}],
    scripts: [{ init: 1 }],
  });
  assert.equal(lines[0], "method 0 ret=3 params=1,2 name=1 flags=0x88 optional=1:0x03");
  assert.equal(error({ methods: [{ flags: 0x20 }] }), "error 1079", "native");
  assert.equal(error({ methods: [{ params: [1], optional: [] }] }), "error 1107");
  assert.equal(error({ methods: [{ params: [], optional: [[1, 3]] }] }), "error 1107");
});

test("metadata names must be strings; keys and values are not checked", () => {
  const lines = dump({ metadata: [{ name: 1, items: [[99, 98]] }] });
  assert.deepEqual(lines, ["metadata 0 name=1 items=99:98"]);
  assert.equal(error({ metadata: [{ name: 0 }] }), "error 1032");
  assert.equal(error({ metadata: [{ name: 4 }] }), "error 1032");
});

test("trait names must be QNames with a namespace and a name", () => {
  const named = (name: number) => error(scriptWith([{ name, kind: SLOT }]));
  assert.equal(named(1), undefined);
  assert.equal(named(7), undefined, "a TypeName names its base");
  assert.equal(named(0), "error 1032");
  assert.equal(named(8), "error 1032");
  assert.equal(named(4), "error 1033", "Multiname");
  assert.equal(named(5), "error 1033", "attribute");
  assert.equal(named(6), "error 1033", "any namespace");
});

test("a builtin ABC may declare native methods and name traits with namespace sets", () => {
  const builtinError = (t: Tables) =>
    (testing.abcDump(abc(pool, tables(t)), true) as string)
      .split("\n")
      .find((l) => l.startsWith("error"));
  assert.equal(builtinError({ methods: [{ flags: 0x20 }] }), undefined, "native");
  const named = (name: number) => builtinError(scriptWith([{ name, kind: SLOT }]));
  assert.equal(named(4), undefined, "Multiname");
  assert.equal(named(5), "error 1033", "attribute");
  assert.equal(named(6), "error 1033", "any namespace");
});

test("trait kinds, values and metadata", () => {
  const lines = dump({
    metadata: [{ name: 1 }],
    ...scriptWith([
      { name: 1, kind: 6, id: 2, index: 3, value: 1, valueKind: 0x03, metadata: [0] },
    ]),
  });
  assert.equal(
    lines.at(-2),
    "  trait script 0 name=1 kind=6 attr=0x40 id=2 index=3 value=1:0x03 metadata=0",
  );
  assert.equal(error(scriptWith([{ name: 1, kind: FUNCTION }])), "error 1045");
  assert.equal(error(scriptWith([{ name: 1, kind: 7 }])), "error 1045");
  assert.equal(error(scriptWith([{ name: 1, kind: SLOT, metadata: [0] }])), "error 1107");
  assert.equal(error(scriptWith([{ name: 1, kind: METHOD, index: 2 }])), "error 1027");
});

test("class traits may only name classes already defined", () => {
  const classTrait = (index: number): Trait => ({ name: 1, kind: CLASS, index });
  const cls = (init: number, traits: Trait[] = []) => ({
    instance: { name: 3, init },
    init: init + 1,
    traits,
  });

  const twoClasses = (traits: Trait[]): Tables => ({
    methods: methods(5),
    classes: [cls(0), cls(2, traits)],
    scripts: [{ init: 4, traits: [classTrait(0), classTrait(1)] }],
  });
  assert.equal(error(twoClasses([classTrait(0)])), undefined, "class 1 names class 0");
  assert.equal(error(twoClasses([classTrait(1)])), "error 1059", "class 1 names itself");
  assert.equal(error(twoClasses([classTrait(2)])), "error 1060");

  const inInstance: Tables = {
    methods: methods(3),
    classes: [{ instance: { name: 3, init: 0, traits: [classTrait(0)] }, init: 1 }],
    scripts: [{ init: 2 }],
  };
  assert.equal(error(inInstance), "error 1059", "no class is defined yet");
});

test("instances check names, base, protected namespace, interfaces and init", () => {
  const withInstance = (instance: Partial<Instance>) =>
    error({
      methods: methods(3),
      classes: [{ instance: { name: 3, init: 0, ...instance }, init: 1 }],
      scripts: [{ init: 2 }],
    });

  const lines = dump({
    methods: methods(3),
    classes: [
      {
        instance: { name: 3, base: 2, flags: 0x01, protectedNs: 1, interfaces: [1], init: 0 },
        init: 1,
      },
    ],
    scripts: [{ init: 2 }],
  });
  assert.equal(lines[3], "instance 0 name=3 super=2 flags=0x09 protectedNs=1 interfaces=1 init=0");
  assert.equal(withInstance({}), undefined);
  assert.equal(withInstance({ name: 4 }), "error 1033");
  assert.equal(withInstance({ base: 8 }), "error 1032");
  assert.equal(withInstance({ protectedNs: 2 }), "error 1032");
  assert.equal(withInstance({ interfaces: [0] }), "error 1111");
  assert.equal(withInstance({ interfaces: [8] }), "error 1032");
  assert.equal(withInstance({ init: 3 }), "error 1027");
});

test("a method belongs to at most one owner", () => {
  const methodTrait = (index: number): Trait => ({ name: 1, kind: METHOD, index });

  assert.equal(error(scriptWith([methodTrait(1), methodTrait(1)])), "error 1107");

  const classes = (instanceInit: number, classInit: number, traits: Trait[] = []): Tables => ({
    methods: methods(4),
    classes: [{ instance: { name: 3, init: instanceInit }, init: classInit, traits }],
    scripts: [{ init: 3 }],
  });
  assert.equal(error(classes(0, 1)), undefined);
  assert.equal(error(classes(0, 0)), "error 1071", "the class init is the instance init");
  assert.equal(
    error(classes(0, 1, [methodTrait(1)])),
    "error 1071",
    "a trait bound the class init",
  );

  const scripts = (inits: number[]): Tables => ({
    methods: methods(2),
    scripts: inits.map((init) => ({ init })),
  });
  assert.equal(error(scripts([0, 0])), "error 1071");

  // A script trait may bind the script's own init first; avmplus ignores that.
  const own = dump(scriptWith([methodTrait(0)]));
  assert.equal(own.includes("bound method 0 to script 0"), true);
  assert.equal(
    own.some((l) => l.startsWith("error")),
    false,
  );
});

test("method bodies: sizes, code, exceptions and activation traits", () => {
  const lines = dump({
    methods: methods(3),
    scripts: [{ init: 0 }],
    bodies: [
      {
        method: 0,
        maxStack: 2,
        localCount: 3,
        initScopeDepth: 1,
        maxScopeDepth: 4,
        code: [0xd0, 0x30, 0x47],
        exceptions: [[0, 2, 2, 99, 0]],
        traits: [{ name: 1, kind: METHOD, index: 1 }],
      },
    ],
  });
  const body = lines.findIndex((l) => l.startsWith("body 0"));
  assert.match(
    lines[body],
    /^body 0 method=0 stack=2 locals=3 scope=1\.\.4 code=\d+\+3 exceptions=0-2>2:99:0$/,
  );
  assert.equal(lines[body + 1], "  trait activation 0 name=1 kind=1 attr=0x00 id=0 index=1");
  assert.equal(lines.includes("bound method 1 to activation 0"), true);
});

test("method bodies are checked like avmplus", () => {
  const withBodies = (bodies: Tables["bodies"], extra: Partial<Tables> = {}) =>
    error({ methods: methods(3), scripts: [{ init: 0 }], bodies, ...extra });

  assert.equal(withBodies([{ method: 0 }, { method: 1 }]), undefined);
  assert.equal(withBodies([{ method: 3 }]), "error 1027");
  assert.equal(withBodies([{ method: 0, code: [] }]), "error 1043");
  assert.equal(withBodies([{ method: 0 }, { method: 0 }]), "error 1121", "duplicate");
  assert.equal(withBodies([{ method: 0, exceptions: [[0, 1, 1, 0, 8]] }]), "error 1032");
  assert.equal(
    withBodies([{ method: 0, traits: [{ name: 1, kind: METHOD, index: 0 }] }]),
    "error 1107",
    "an activation binds a method that already has an owner",
  );

  const interfaceMethod: Partial<Tables> = {
    classes: [
      {
        instance: { name: 3, flags: 0x04, init: 1, traits: [{ name: 1, kind: METHOD, index: 2 }] },
        init: 0,
      },
    ],
    methods: methods(4),
    scripts: [{ init: 3 }],
  };
  assert.equal(withBodies([{ method: 2 }], interfaceMethod), "error 1122");
  assert.equal(withBodies([{ method: 0 }], interfaceMethod), undefined, "the class init");
});

test("bytecode may not reach the end of the ABC", () => {
  const upToBodies = abc(pool, tables({ methods: methods(1), scripts: [{ init: 0 }] })).slice(
    0,
    -1,
  );
  const body = (codeLength: number) => [0, 1, 1, 0, 1, ...u30(codeLength), 0x47];
  assert.equal(testing.abcDump(new Uint8Array([...upToBodies, 1, ...body(1)])), "error 1107");
  assert.equal(testing.abcDump(new Uint8Array([...upToBodies, 1, ...body(100000)])), "error 1107");
});

test("truncated tables are corrupt", () => {
  const bytes = abc(
    pool,
    tables({
      methods: [{ params: [1], optional: [[1, 3]] }, {}, {}],
      metadata: [{ name: 1, items: [[1, 2]] }],
      classes: [
        {
          instance: { name: 3, interfaces: [1], init: 0 },
          init: 1,
          traits: [{ name: 1, kind: SLOT }],
        },
      ],
      scripts: [{ init: 2, traits: [{ name: 2, kind: CLASS, index: 0 }] }],
      bodies: [{ method: 0, exceptions: [[0, 1, 1, 0, 1]], traits: [{ name: 1, kind: SLOT }] }],
    }),
  );
  const whole = (testing.abcDump(bytes) as string).split("\n");
  assert.equal(
    whole.some((l) => l.startsWith("error")),
    false,
  );

  const poolEnd = abc(pool, []).length;
  for (let length = poolEnd; length < bytes.length; length++) {
    const lines = (testing.abcDump(bytes.slice(0, length)) as string).split("\n");
    assert.equal(lines.at(-1), "error 1107", `length ${length}`);
  }
});

test("accepts ABC 46.16 and 47.12 to 47.18, as Flash Player builds of avmplus", () => {
  const withVersion = (major: number, minor: number) => {
    const bytes = abc(pool, tables({}));
    bytes.set([minor & 0xff, minor >> 8, major & 0xff, major >> 8], 0);
    return testing.abcDump(bytes) as string;
  };

  assert.equal(withVersion(46, 16), "");
  for (let minor = 12; minor <= 18; minor++) {
    assert.equal(withVersion(47, minor), "", `47.${minor}`);
  }

  for (const [major, minor] of [
    [46, 15],
    [46, 17],
    [47, 11],
    [47, 19],
    [48, 0],
  ]) {
    assert.equal(withVersion(major, minor), "error 1042", `${major}.${minor}`);
  }
});
