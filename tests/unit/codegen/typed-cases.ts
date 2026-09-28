// Script initializers the typed verifier checks, with the VerifyError avmplus
// reports for each. typed.test.ts checks swf2es against these, and
// `pnpm oracle:cases` checks them against avmshell.
import { abc, type Body, type Trait, tables, u30 } from "./abc-builder.ts";
import type { Case } from "./oracle-case.ts";

// Strings 1 a, 2 "", 3 Missing, 4 void, 5 int, 6 Object, 7 A. Namespace 1 public.
// Multinames: 1 a, 2 RTQNameL, 3 Missing, 4 void, 5 int, 6 Object, 7 A.
const pool = {
  strings: ["a", "", "Missing", "void", "int", "Object", "A"],
  namespaces: [[0x16, ...u30(2)]],
  multinames: [
    [0x07, ...u30(1), ...u30(1)],
    [0x11],
    [0x07, ...u30(1), ...u30(3)],
    [0x07, ...u30(1), ...u30(4)],
    [0x07, ...u30(1), ...u30(5)],
    [0x07, ...u30(1), ...u30(6)],
    [0x07, ...u30(1), ...u30(7)],
  ],
};

const s24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

const IFTRUE = 0x11;
const NEWFUNCTION = 0x40;
const CALL = 0x41;
const NEWCLASS = 0x58;
const JUMP = 0x10;
const LOOKUPSWITCH = 0x1b;
const PUSHWITH = 0x1c;
const POPSCOPE = 0x1d;
const PUSHNULL = 0x20;
const PUSHBYTE = 0x24;
const PUSHTRUE = 0x26;
const POP = 0x29;
const PUSHSTRING = 0x2c;
const PUSHSCOPE = 0x30;
const HASNEXT2 = 0x32;
const CALLMETHOD = 0x43;
const CALLPROPERTY = 0x46;
const RETURNVOID = 0x47;
const CONSTRUCTSUPER = 0x49;
const NEWOBJECT = 0x55;
const GETLEX = 0x60;
const GETGLOBALSCOPE = 0x64;
const GETOUTERSCOPE = 0x67;
const GETSLOT = 0x6c;
const SETGLOBALSLOT = 0x6f;
const COERCE = 0x80;
const ASTYPE = 0x86;
const GETLOCAL0 = 0xd0;
const GETLOCAL1 = 0xd1;
const SETLOCAL1 = 0xd5;

/**
 * An ABC whose script initializer has `code`, and method 1 `function`, the
 * body of a function the script may create.
 */
function withFunction(code: number[], fn: number[]): Uint8Array {
  return abc(
    pool,
    tables({
      methods: [{}, {}],
      scripts: [{ init: 0 }],
      bodies: [
        { method: 0, code, maxStack: 4, localCount: 1, maxScopeDepth: 2 },
        { method: 1, code: fn, maxStack: 4, localCount: 1, maxScopeDepth: 2 },
      ],
    }),
  );
}

/** An ABC whose script creates class A, extending Object, with `code` before newclass. */
function withClass(code: number[]): Uint8Array {
  return abc(
    pool,
    tables({
      methods: [{}, {}, {}],
      classes: [{ instance: { name: 7, base: 6, init: 0 }, init: 1 }],
      scripts: [{ init: 2, traits: [{ name: 7, kind: 4, id: 1, index: 0 }] }],
      bodies: [
        { method: 2, code: [...code, NEWCLASS, 0, POP, RETURNVOID], maxStack: 4, maxScopeDepth: 3 },
        { method: 1, code: [RETURNVOID] },
      ],
    }),
  );
}

// Create the function in the global scope and call it.
const callIt = [GETLOCAL0, PUSHSCOPE, NEWFUNCTION, 1, PUSHNULL, CALL, 0, POP, RETURNVOID];

/** An ABC whose script initializer has `code`, and the script `traits`. */
function script(code: number[], frame: Partial<Body> = {}, traits: Trait[] = []): Uint8Array {
  const body: Body = { method: 0, code, maxStack: 4, localCount: 2, ...frame };
  return abc(pool, tables({ methods: [{}], scripts: [{ init: 0, traits }], bodies: [body] }));
}

// 0 pushtrue; 1 iftrue +6 to 11; 5 getlocal0; 6 pushscope; 7 jump +2 to 13;
// 11 getlocal0; 12 pushwith; 13 popscope; 14 returnvoid.
const scopeOrWith = [
  PUSHTRUE,
  IFTRUE,
  ...s24(6),
  GETLOCAL0,
  PUSHSCOPE,
  JUMP,
  ...s24(2),
  GETLOCAL0,
  PUSHWITH,
  POPSCOPE,
  RETURNVOID,
];

export const typedCases: Case[] = [
  {
    name: "lookupswitch needs an int",
    abc: script([PUSHNULL, LOOKUPSWITCH, ...s24(8), 0, ...s24(8), RETURNVOID]),
    error: 1058,
  },
  {
    name: "lookupswitch on an int",
    abc: script([PUSHBYTE, 0, LOOKUPSWITCH, ...s24(8), 0, ...s24(8), RETURNVOID]),
  },
  {
    name: "hasnext2 needs an int index",
    abc: script([HASNEXT2, 0, 1, POP, RETURNVOID]),
    error: 1058,
  },
  {
    name: "hasnext2 with an int index",
    abc: script([PUSHBYTE, 0, SETLOCAL1, HASNEXT2, 0, 1, POP, RETURNVOID]),
  },
  {
    name: "a scope and a with scope cannot merge",
    abc: script(scopeOrWith, { maxScopeDepth: 1 }),
    error: 1068,
  },
  {
    name: "getslot on an untyped value",
    abc: script([GETLOCAL1, GETSLOT, 1, POP, RETURNVOID]),
    error: 1051,
  },
  {
    name: "getslot past the slots",
    abc: script([GETLOCAL0, GETSLOT, 1, POP, RETURNVOID]),
    error: 1026,
  },
  {
    name: "getslot of the global's slot",
    abc: script([GETLOCAL0, GETSLOT, 1, POP, RETURNVOID], {}, [{ name: 1, kind: 0 }]),
  },
  { name: "callmethod", abc: script([GETLOCAL0, CALLMETHOD, 1, 0, POP, RETURNVOID]), error: 1051 },
  {
    name: "callmethod with dispatch id 0",
    abc: script([GETLOCAL0, CALLMETHOD, 0, 0, POP, RETURNVOID]),
    error: 1072,
  },
  {
    name: "newobject needs string names",
    abc: script([PUSHNULL, PUSHNULL, NEWOBJECT, 1, POP, RETURNVOID]),
    error: 1058,
  },
  {
    name: "newobject with a string name",
    abc: script([PUSHSTRING, 1, PUSHNULL, NEWOBJECT, 1, POP, RETURNVOID]),
  },
  {
    name: "a runtime name with a namespace must be a String",
    abc: script([GETLOCAL0, PUSHNULL, PUSHNULL, CALLPROPERTY, 2, 0, POP, RETURNVOID]),
    error: 1058,
  },
  { name: "getlex with no scope", abc: script([GETLEX, 1, POP, RETURNVOID]), error: 1013 },
  {
    name: "getouterscope in a script",
    abc: script([GETOUTERSCOPE, 0, POP, RETURNVOID]),
    error: 1019,
  },
  {
    name: "getglobalscope with no scope",
    abc: script([GETGLOBALSCOPE, POP, RETURNVOID]),
    error: 1019,
  },
  {
    name: "setglobalslot with no scope",
    abc: script([PUSHNULL, SETGLOBALSLOT, 1, RETURNVOID]),
    error: 1114,
  },
  {
    name: "constructsuper with too many arguments",
    abc: script([GETLOCAL0, PUSHNULL, CONSTRUCTSUPER, 1, RETURNVOID]),
    error: 1063,
  },
  {
    name: "coerce to a missing type",
    abc: script([PUSHNULL, COERCE, 3, POP, RETURNVOID]),
    error: 1014,
  },
  { name: "coerce to void", abc: script([PUSHNULL, COERCE, 4, POP, RETURNVOID]) },
  {
    name: "astype a missing type",
    abc: script([PUSHNULL, ASTYPE, 3, POP, RETURNVOID]),
    error: 1014,
  },
  { name: "coerce to int", abc: script([PUSHNULL, COERCE, 5, POP, RETURNVOID]) },
  { name: "newclass with no scope", abc: withClass([GETLEX, 6]), error: 1013 },
  {
    name: "newclass in the global scope",
    abc: withClass([GETLOCAL0, PUSHSCOPE, GETLEX, 6]),
    error: 1107,
  },
  {
    name: "newclass in its base class's scope",
    abc: withClass([GETLOCAL0, PUSHSCOPE, GETLEX, 6, PUSHSCOPE, GETLEX, 6]),
  },
  {
    name: "a function created in two scope chains",
    abc: withFunction(
      [NEWFUNCTION, 1, POP, GETLOCAL0, PUSHSCOPE, NEWFUNCTION, 1, POP, POPSCOPE, RETURNVOID],
      [RETURNVOID],
    ),
    error: 1107,
  },
  {
    name: "a method bound to traits made a function",
    abc: script([NEWFUNCTION, 0, POP, RETURNVOID]),
    error: 1107,
  },
  {
    name: "getouterscope in a function",
    abc: withFunction(callIt, [GETOUTERSCOPE, 0, POP, RETURNVOID]),
  },
  {
    name: "getouterscope past a function's scope chain",
    abc: withFunction(callIt, [GETOUTERSCOPE, 1, POP, RETURNVOID]),
    error: 1019,
  },
  {
    name: "getlex in a function's scope chain",
    abc: withFunction(callIt, [GETLEX, 5, POP, RETURNVOID]),
  },
  {
    name: "getlex in a function created with no scope",
    abc: withFunction(
      [NEWFUNCTION, 1, PUSHNULL, CALL, 0, POP, RETURNVOID],
      [GETLEX, 5, POP, RETURNVOID],
    ),
    error: 1013,
  },
  {
    name: "getglobalscope and a global slot in a function",
    abc: withFunction(callIt, [GETGLOBALSCOPE, POP, RETURNVOID]),
  },
];
