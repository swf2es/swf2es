// User ABCs whose classes link against builtin.abc, with the error avmplus
// reports while loading each. domain.test.ts checks swf2es against these,
// and `pnpm oracle:cases` checks them against avmshell.
import { abc, type Instance, tables, u30 } from "./abc-builder.ts";
import type { Case } from "./oracle-case.ts";

const STRINGS = ["", "Object", "Class", "Function", "void", "Error", "A", "B", "I", "F", "Missing"];
/** Multiname index of public::name, for each of STRINGS[1..]. */
const mn = (name: string) => STRINGS.indexOf(name);

// Namespaces: 1 public, 2 package "A" (a second namespace for ambiguity).
// Multinames 1..10: public::Object .. public::Missing; 11: {public, A}::A;
// 12: A::A. String k of STRINGS is pool string k + 1.
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

type Class = Omit<Instance, "init">;

/** An ABC defining `classes` in order; its script init just returns. */
function classes(list: Class[]): Uint8Array {
  const script = 2 * list.length;
  return abc(
    pool,
    tables({
      methods: Array.from({ length: script + 1 }, () => ({})),
      classes: list.map((c, i) => ({ instance: { ...c, init: 2 * i }, init: 2 * i + 1 })),
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
];
