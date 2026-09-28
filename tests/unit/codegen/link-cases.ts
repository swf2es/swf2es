// User ABCs whose classes link against builtin.abc, with the error avmplus
// reports while loading each. domain.test.ts checks swf2es against these,
// and `pnpm oracle:cases` checks them against avmshell.
import { abc, type Instance, type Trait, tables, u30 } from "./abc-builder.ts";
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
];
/** Multiname index of public::name, for each of STRINGS[1..]. */
export const mn = (name: string) => STRINGS.indexOf(name);

// Namespaces: 1 public, 2 package "A" (a second namespace for ambiguity).
// Multinames 1..13: public::Object .. public::prototype; 14: {public, A}::A;
// 15: A::A. String k of STRINGS is pool string k + 1.
const pool = {
  strings: STRINGS,
  namespaces: [
    [0x16, ...u30(1)],
    [0x16, ...u30(7)],
  ],
  nsSets: [[1, 2]],
  multinames: [
    ...STRINGS.slice(1).map((_, i) => [0x07, ...u30(1), ...u30(i + 2)]),
    [0x09, ...u30(7), ...u30(1)],
    [0x07, ...u30(2), ...u30(7)],
  ],
};
const AMBIGUOUS_A = STRINGS.length;

/** A trait; methods, getters and setters get a method of their own. */
type Member = Omit<Trait, "index"> & { index?: number };
type Class = Omit<Instance, "init" | "traits"> & { traits?: Member[]; statics?: Member[] };

export const METHOD = 1;
export const GETTER = 2;
export const SETTER = 3;
export const OVERRIDE = 0x20;

/** An ABC defining `classes` in order; its script init just returns. */
export function classes(list: Class[]): Uint8Array {
  const script = 2 * list.length;
  let methods = script + 1;
  const withMethods = (traits: Member[] = []): Trait[] =>
    traits.map((t) => (t.kind >= METHOD && t.kind <= SETTER ? { ...t, index: methods++ } : t));
  const defined = list.map((c, i) => ({
    instance: { ...c, init: 2 * i, traits: withMethods(c.traits) },
    init: 2 * i + 1,
    traits: withMethods(c.statics),
  }));
  return abc(
    pool,
    tables({
      methods: Array.from({ length: methods }, () => ({})),
      classes: defined,
      scripts: [
        {
          init: script,
          traits: list.map((c, i) => ({ name: c.name, kind: 4, id: i + 1, index: i })),
        },
      ],
      bodies: [{ method: script, code: [0x47] }],
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
