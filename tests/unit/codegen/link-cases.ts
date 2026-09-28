// User ABCs whose classes link against builtin.abc, with the error avmplus
// reports while loading each (linkCases) or while creating each class, when
// it resolves their types (resolveCases). domain.test.ts checks swf2es
// against these, and `pnpm oracle:cases` checks them against avmshell.
import { abc, type Instance, type Method, type Trait, tables, u30 } from "./abc-builder.ts";
import type { Case } from "./oracle-case.ts";

const STRINGS = [
  "",
  "Object",
  "Class",
  "Function",
  "void",
  "Error",
  "A",
  "B",
  "I",
  "F",
  "Missing",
  "m",
  "x",
  "prototype",
  "int",
  "uint",
  "Number",
  "String",
  "Boolean",
  "n",
];
/** Multiname index of public::name, for each of STRINGS[1..]. */
export const mn = (name: string) => STRINGS.indexOf(name);

// Namespaces: 1 public, 2 package "A" (a second namespace for ambiguity),
// 3 the namespace of interface I's members. Multinames 1..: public::Object
// and on for STRINGS; then {public, A}::A; A::A; I::m. String k of STRINGS
// is pool string k + 1. Ints 1: 3, 2: -1; doubles 1: 1.5.
const pool = {
  strings: STRINGS,
  ints: [3, -1],
  doubles: [1.5],
  namespaces: [
    [0x16, ...u30(1)],
    [0x16, ...u30(7)],
    [0x08, ...u30(9)],
  ],
  nsSets: [[1, 2]],
  multinames: [
    ...STRINGS.slice(1).map((_, i) => [0x07, ...u30(1), ...u30(i + 2)]),
    [0x09, ...u30(7), ...u30(1)],
    [0x07, ...u30(2), ...u30(7)],
    [0x07, ...u30(3), ...u30(STRINGS.indexOf("m") + 1)],
  ],
};
const AMBIGUOUS_A = STRINGS.length;
export const I_M = STRINGS.length + 2;

/** A trait; methods, getters and setters get a method of their own, with signature `sig`. */
type Member = Omit<Trait, "index"> & { index?: number; sig?: Method };
type Class = Omit<Instance, "init" | "traits"> & { traits?: Member[]; statics?: Member[] };

export const METHOD = 1;
export const GETTER = 2;
export const SETTER = 3;
export const OVERRIDE = 0x20;
const FINAL_METHOD = 0x10;

/**
 * An ABC defining `classes` in order. Its script init just returns, or with
 * `create` creates each class, which is when avmplus resolves its types.
 */
export function classes(list: Class[], create = false): Uint8Array {
  const script = 2 * list.length;
  const methods: Method[] = Array.from({ length: script + 1 }, () => ({}));
  const withMethods = (traits: Member[] = []): Trait[] =>
    traits.map(({ sig, ...t }) => {
      if (t.kind < METHOD || t.kind > SETTER) {
        return t;
      }

      methods.push(sig ?? {});
      return { ...t, index: methods.length - 1 };
    });
  const defined = list.map((c, i) => ({
    instance: { ...c, init: 2 * i, traits: withMethods(c.traits) },
    init: 2 * i + 1,
    traits: withMethods(c.statics),
  }));

  // As ASC: newclass with the base class objects on the scope chain.
  const chain = (base?: number): number[] => {
    if (!base) {
      return [];
    }

    const c = list.find((d) => d.name === base);
    return [...(c ? chain(c.base) : base === mn("Object") ? [] : [mn("Object")]), base];
  };
  const code = [0xd0, 0x30];
  let depth = 1;
  for (const [i, c] of list.entries()) {
    const scopes = chain(c.base);
    depth = Math.max(depth, 1 + scopes.length);
    code.push(0xd0);
    for (const n of scopes) {
      code.push(0x60, ...u30(n), 0x30);
    }

    code.push(...(c.base ? [0x60, ...u30(c.base)] : [0x20]), 0x58, ...u30(i));
    code.push(...scopes.map(() => 0x1d), 0x68, ...u30(c.name));
  }

  return abc(
    pool,
    tables({
      methods,
      classes: defined,
      scripts: [
        {
          init: script,
          traits: list.map((c, i) => ({ name: c.name, kind: 4, id: i + 1, index: i })),
        },
      ],
      // newclass runs each class initializer, so created classes need theirs.
      bodies: create
        ? [
            { method: script, code: [...code, 0x47], maxStack: 4, maxScopeDepth: depth },
            ...list.map((_, i) => ({ method: 2 * i + 1, code: [0x47] })),
          ]
        : [{ method: script, code: [0x47] }],
    }),
  );
}

export const SLOT = 0;
const SEALED = 0x01;
const FINAL = 0x02;
const INTERFACE = 0x04;

export const linkCases: Case[] = [
  { name: "extends Object", abc: classes([{ name: mn("A"), base: mn("Object") }]) },
  {
    name: "extends a missing class",
    abc: classes([{ name: mn("A"), base: mn("Missing") }]),
    error: 1014,
  },
  {
    name: "extends an earlier class",
    abc: classes([
      { name: mn("A"), base: mn("Object") },
      { name: mn("B"), base: mn("A") },
    ]),
  },
  {
    name: "extends a later class",
    abc: classes([
      { name: mn("B"), base: mn("A") },
      { name: mn("A"), base: mn("Object") },
    ]),
    error: 1014,
  },
  {
    name: "extends a final class",
    abc: classes([
      { name: mn("F"), base: mn("Object"), flags: SEALED | FINAL },
      { name: mn("A"), base: mn("F") },
    ]),
    error: 1103,
  },
  { name: "extends Class", abc: classes([{ name: mn("A"), base: mn("Class") }]), error: 1103 },
  {
    name: "extends Function",
    abc: classes([{ name: mn("A"), base: mn("Function") }]),
    error: 1103,
  },
  { name: "extends void", abc: classes([{ name: mn("A"), base: mn("void") }]), error: 1022 },
  {
    name: "extends an interface",
    abc: classes([
      { name: mn("I"), flags: INTERFACE },
      { name: mn("A"), base: mn("I") },
    ]),
    error: 1110,
  },
  {
    name: "an interface with a base class",
    abc: classes([{ name: mn("I"), base: mn("Object"), flags: INTERFACE }]),
    error: 1110,
  },
  {
    name: "implements an interface",
    abc: classes([
      { name: mn("I"), flags: INTERFACE },
      { name: mn("A"), base: mn("Object"), interfaces: [mn("I")] },
    ]),
  },
  {
    name: "implements a class",
    abc: classes([{ name: mn("A"), base: mn("Object"), interfaces: [mn("Error")] }]),
    error: 1111,
  },
  {
    name: "implements a missing interface",
    abc: classes([{ name: mn("A"), base: mn("Object"), interfaces: [mn("Missing")] }]),
    error: 1014,
  },
  {
    name: "extends an ambiguous name",
    abc: classes([
      { name: mn("A"), base: mn("Object") },
      { name: AMBIGUOUS_A + 1, base: mn("Object") },
      { name: mn("B"), base: AMBIGUOUS_A },
    ]),
    error: 1008,
  },
  {
    name: "a method must override a base method",
    abc: classes([
      { name: mn("A"), base: mn("Object"), traits: [{ name: mn("m"), kind: METHOD }] },
      { name: mn("B"), base: mn("A"), traits: [{ name: mn("m"), kind: METHOD }] },
    ]),
    error: 1053,
  },
  {
    name: "a method overrides a base method",
    abc: classes([
      { name: mn("A"), base: mn("Object"), traits: [{ name: mn("m"), kind: METHOD }] },
      { name: mn("B"), base: mn("A"), traits: [{ name: mn("m"), kind: METHOD, attr: OVERRIDE }] },
    ]),
  },
  {
    name: "an override of nothing",
    abc: classes([
      {
        name: mn("A"),
        base: mn("Object"),
        traits: [{ name: mn("m"), kind: METHOD, attr: OVERRIDE }],
      },
    ]),
    error: 1053,
  },
  {
    name: "a getter cannot override a method",
    abc: classes([
      { name: mn("A"), base: mn("Object"), traits: [{ name: mn("m"), kind: METHOD }] },
      { name: mn("B"), base: mn("A"), traits: [{ name: mn("m"), kind: GETTER, attr: OVERRIDE }] },
    ]),
    error: 1053,
  },
  {
    name: "a getter and a setter pair",
    abc: classes([
      {
        name: mn("A"),
        base: mn("Object"),
        traits: [
          { name: mn("x"), kind: GETTER },
          { name: mn("x"), kind: SETTER },
        ],
      },
    ]),
  },
  {
    name: "a getter beside a base setter overrides nothing",
    abc: classes([
      { name: mn("A"), base: mn("Object"), traits: [{ name: mn("x"), kind: SETTER }] },
      { name: mn("B"), base: mn("A"), traits: [{ name: mn("x"), kind: GETTER }] },
    ]),
  },
  {
    name: "a getter beside a base setter may not say override",
    abc: classes([
      { name: mn("A"), base: mn("Object"), traits: [{ name: mn("x"), kind: SETTER }] },
      { name: mn("B"), base: mn("A"), traits: [{ name: mn("x"), kind: GETTER, attr: OVERRIDE }] },
    ]),
    error: 1053,
  },
  {
    name: "a slot id the base class has",
    abc: classes([
      { name: mn("A"), base: mn("Object"), traits: [{ name: mn("x"), kind: SLOT, id: 1 }] },
      { name: mn("B"), base: mn("A"), traits: [{ name: mn("m"), kind: SLOT, id: 1 }] },
    ]),
    error: 1053,
  },
  {
    name: "two slots with one name",
    abc: classes([
      {
        name: mn("A"),
        base: mn("Object"),
        traits: [
          { name: mn("x"), kind: SLOT },
          { name: mn("x"), kind: SLOT },
        ],
      },
    ]),
    error: 1107,
  },
  {
    name: "a slot id past the trait count",
    abc: classes([
      { name: mn("A"), base: mn("Object"), traits: [{ name: mn("x"), kind: SLOT, id: 5 }] },
    ]),
    error: 1107,
  },
  {
    name: "an interface with a slot",
    abc: classes([{ name: mn("I"), flags: INTERFACE, traits: [{ name: mn("x"), kind: SLOT }] }]),
    error: 1057,
  },
  {
    name: "a static getter must override Class's",
    abc: classes([
      { name: mn("A"), base: mn("Object"), statics: [{ name: mn("prototype"), kind: GETTER }] },
    ]),
    error: 1053,
  },
];

const A_OBJECT = { name: mn("A"), base: mn("Object") };
const INT = 0x03;
const DOUBLE = 0x06;
const UTF8 = 0x01;
const TRUE = 0x0b;
const NULL = 0x0c;

/** Class A with one slot of `type`, whose default is `value` of `kind`. */
const slotOf = (type: number, value = 0, kind = 0) =>
  classes(
    [{ ...A_OBJECT, traits: [{ name: mn("x"), kind: SLOT, index: type, value, valueKind: kind }] }],
    true,
  );

/** Class A with method m of `sig`, and B extending it with `over`. */
const overriding = (sig: Method, over: Method, attr = OVERRIDE, final = 0) =>
  classes(
    [
      { ...A_OBJECT, traits: [{ name: mn("m"), kind: METHOD, sig, attr: final }] },
      { name: mn("B"), base: mn("A"), traits: [{ name: mn("m"), kind: METHOD, sig: over, attr }] },
    ],
    true,
  );

/** Interface I with method m of `sig`, in its own namespace, and A implementing it with `impl`. */
const implementing = (sig: Method, impl?: Method) =>
  classes(
    [
      { name: mn("I"), flags: INTERFACE, traits: [{ name: I_M, kind: METHOD, sig }] },
      {
        ...A_OBJECT,
        interfaces: [mn("I")],
        traits: impl ? [{ name: mn("m"), kind: METHOD, sig: impl }] : [],
      },
    ],
    true,
  );

export const resolveCases: Case[] = [
  { name: "classes are created", abc: classes([A_OBJECT, { name: mn("B"), base: mn("A") }], true) },
  { name: "a slot of a missing type", abc: slotOf(mn("Missing")), error: 1014 },
  { name: "a slot of type void", abc: slotOf(mn("void")), error: 1022 },
  { name: "a slot of type int", abc: slotOf(mn("int"), 1, INT) },
  { name: "an int slot with a fraction", abc: slotOf(mn("int"), 1, DOUBLE), error: 1102 },
  { name: "a uint slot below zero", abc: slotOf(mn("uint"), 2, INT), error: 1102 },
  { name: "a String slot set to true", abc: slotOf(mn("String"), 1, TRUE), error: 1102 },
  { name: "a Number slot set to a string", abc: slotOf(mn("Number"), 1, UTF8), error: 1102 },
  { name: "a Number slot set to null", abc: slotOf(mn("Number"), 1, NULL), error: 1102 },
  { name: "a String slot set to null", abc: slotOf(mn("String"), 1, NULL) },
  { name: "a default past the pool", abc: slotOf(mn("int"), 9, INT), error: 1032 },
  {
    name: "a parameter of a missing type",
    abc: classes(
      [
        {
          ...A_OBJECT,
          traits: [{ name: mn("m"), kind: METHOD, sig: { params: [mn("Missing")] } }],
        },
      ],
      true,
    ),
    error: 1014,
  },
  {
    name: "a parameter of type void",
    abc: classes(
      [{ ...A_OBJECT, traits: [{ name: mn("m"), kind: METHOD, sig: { params: [mn("void")] } }] }],
      true,
    ),
    error: 1022,
  },
  {
    name: "a Boolean parameter defaulting to null",
    abc: classes(
      [
        {
          ...A_OBJECT,
          traits: [
            {
              name: mn("m"),
              kind: METHOD,
              sig: { params: [mn("Boolean")], optional: [[1, NULL]] },
            },
          ],
        },
      ],
      true,
    ),
    error: 1102,
  },
  {
    name: "an override with the same signature",
    abc: overriding({ ret: mn("int") }, { ret: mn("int") }),
  },
  {
    name: "an override returning another type",
    abc: overriding({ ret: mn("int") }, { ret: mn("uint") }),
    error: 1053,
  },
  {
    name: "an override with another parameter count",
    abc: overriding({ params: [mn("int")] }, { params: [mn("int"), mn("int")] }),
    error: 1053,
  },
  {
    name: "an override of a final method",
    abc: overriding({}, {}, OVERRIDE, FINAL_METHOD),
    error: 1053,
  },
  {
    name: "an interface method implemented",
    abc: implementing({ ret: mn("int") }, { ret: mn("int") }),
  },
  { name: "an interface method missing", abc: implementing({ ret: mn("int") }), error: 1053 },
  {
    name: "an interface method implemented with another signature",
    abc: implementing({ ret: mn("int") }, { ret: mn("String") }),
    error: 1053,
  },
];
