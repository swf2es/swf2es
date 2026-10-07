// Copies the compiler leaves unwritten (emit/copies.ts), run with the
// runtime: hand-built script initializers that trace what avmshell traces
// for them, where a copy's original changes, or is not written, before the
// copy is read.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runSwf2es } from "../../conformance/swf2es.ts";
import { abc, tables, u30 } from "./abc-builder.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";

// Strings 1 trace, 2 int, 3 "", 4 x, 5 first, 6 second. Namespace 1 public.
// Multinames 1 trace, 2 int, 3 x.
const pool = {
  strings: ["trace", "int", "", "x", "first", "second"],
  namespaces: [[0x16, ...u30(3)]],
  multinames: [
    [0x07, ...u30(1), ...u30(1)],
    [0x07, ...u30(1), ...u30(2)],
    [0x07, ...u30(1), ...u30(4)],
  ],
};

const GETLOCAL0 = 0xd0;
const GETLOCAL1 = 0xd1;
const GETLOCAL2 = 0xd2;
const SETLOCAL1 = 0xd5;
const SETLOCAL2 = 0xd6;
const PUSHSCOPE = 0x30;
const PUSHWITH = 0x1c;
const POPSCOPE = 0x1d;
const PUSHBYTE = 0x24;
const PUSHSTRING = 0x2c;
const PUSHTRUE = 0x26;
const PUSHFALSE = 0x27;
const NEWOBJECT = 0x55;
const FINDPROPSTRICT = 0x5d;
const GETPROPERTY = 0x66;
const CALLPROPERTY = 0x46;
const CALLPROPVOID = 0x4f;
const INCLOCAL_I = 0xc2;
const IFFALSE = 0x12;
const JUMP = 0x10;
const RETURNVOID = 0x47;
const TRACE = 1;
const INT = 2;
const X = 3;
// Strings x, first and second.
const S_X = 4;
const S_FIRST = 5;
const S_SECOND = 6;

/** A branch to a label, or a label: what `assemble` resolves. */
type Item = number | { branch: number; to: string } | { label: string };

/** Bytecode from items, each branch's offset counted from after it to its label. */
function assemble(items: Item[]): number[] {
  const at = new Map<string, number>();
  let pc = 0;
  for (const item of items) {
    if (typeof item === "number") {
      pc++;
    } else if ("label" in item) {
      at.set(item.label, pc);
    } else {
      pc += 4;
    }
  }

  const code: number[] = [];
  for (const item of items) {
    if (typeof item === "number") {
      code.push(item);
    } else if ("branch" in item) {
      const offset = (at.get(item.to) ?? 0) - (code.length + 4);
      code.push(item.branch, offset & 0xff, (offset >> 8) & 0xff, (offset >> 16) & 0xff);
    }
  }

  return code;
}

/** What the script initializer `items` traces, run after avmshell's builtins. */
async function traced(items: Item[]): Promise<string[]> {
  const body = { method: 0, code: assemble(items), maxStack: 6, localCount: 3, maxScopeDepth: 3 };
  const bytes = abc(pool, tables({ methods: [{}], scripts: [{ init: 0 }], bodies: [body] }));
  const builtins = ["builtin.abc", "shell_toplevel.abc"].map(
    (f) => new Uint8Array(readFileSync(new URL(f, generated))),
  );
  return runSwf2es(builtins, bytes);
}

test("a nip of a conversion that writes nothing is read on each side of a merge", {
  skip,
}, async () => {
  // l1 = 5; l2 = 6; trace(c ? int(l1) : int(l2)): each side's int() is a
  // conversion that writes nothing and a nip, whose value meets the other
  // side's past the branch.
  const code = (c: number): Item[] => [
    GETLOCAL0,
    PUSHSCOPE,
    PUSHBYTE,
    5,
    SETLOCAL1,
    PUSHBYTE,
    6,
    SETLOCAL2,
    FINDPROPSTRICT,
    TRACE,
    c,
    { branch: IFFALSE, to: "else" },
    FINDPROPSTRICT,
    INT,
    GETLOCAL1,
    CALLPROPERTY,
    INT,
    1,
    { branch: JUMP, to: "end" },
    { label: "else" },
    FINDPROPSTRICT,
    INT,
    GETLOCAL2,
    CALLPROPERTY,
    INT,
    1,
    { label: "end" },
    CALLPROPVOID,
    TRACE,
    1,
    RETURNVOID,
  ];
  assert.deepEqual(await traced(code(PUSHTRUE)), ["5"]);
  assert.deepEqual(await traced(code(PUSHFALSE)), ["6"]);
});

test("a nip of a local is written before the local changes", { skip }, async () => {
  // l1 = 7; trace(int(l1), l1++ as a statement between): the nip copies l1,
  // which changes before the trace reads it; then l1 itself.
  const code: Item[] = [
    GETLOCAL0,
    PUSHSCOPE,
    PUSHBYTE,
    7,
    SETLOCAL1,
    FINDPROPSTRICT,
    TRACE,
    FINDPROPSTRICT,
    INT,
    GETLOCAL1,
    CALLPROPERTY,
    INT,
    1,
    INCLOCAL_I,
    1,
    CALLPROPVOID,
    TRACE,
    1,
    FINDPROPSTRICT,
    TRACE,
    GETLOCAL1,
    CALLPROPVOID,
    TRACE,
    1,
    RETURNVOID,
  ];
  assert.deepEqual(await traced(code), ["7", "8"]);
});

test("a scope that copies a local keeps its object when the local is set again", {
  skip,
}, async () => {
  // l1 = {x: "first"}; with (l1) { if (true) {} l1 = {x: "second"}; trace(x) }:
  // the with scope copies l1, which changes in a later block before
  // findpropstrict looks x up in the scopes.
  const code: Item[] = [
    GETLOCAL0,
    PUSHSCOPE,
    PUSHSTRING,
    S_X,
    PUSHSTRING,
    S_FIRST,
    NEWOBJECT,
    1,
    SETLOCAL1,
    GETLOCAL1,
    PUSHWITH,
    PUSHTRUE,
    { branch: IFFALSE, to: "next" },
    { label: "next" },
    PUSHSTRING,
    S_X,
    PUSHSTRING,
    S_SECOND,
    NEWOBJECT,
    1,
    SETLOCAL1,
    FINDPROPSTRICT,
    TRACE,
    FINDPROPSTRICT,
    X,
    GETPROPERTY,
    X,
    CALLPROPVOID,
    TRACE,
    1,
    POPSCOPE,
    RETURNVOID,
  ];
  assert.deepEqual(await traced(code), ["first"]);
});
