// Values the compiler holds as text and writes into what reads them
// (MethodEmitter.hold, emit/blocks.ts), run with the runtime: hand-built
// script initializers, with the stack operations ASC seldom writes and
// Crossbridge writes often, that trace what avmshell traces for them,
// where something a held value reads changes before the value is read.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runSwf2es } from "../../conformance/swf2es.ts";
import { abc, tables, u30 } from "./abc-builder.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";

// Strings 1 trace, 2 "". Namespace 1 public. Multiname 1 trace.
const pool = {
  strings: ["trace", ""],
  namespaces: [[0x16, ...u30(2)]],
  multinames: [[0x07, ...u30(1), ...u30(1)]],
};

const GETLOCAL0 = 0xd0;
const GETLOCAL1 = 0xd1;
const GETLOCAL2 = 0xd2;
const SETLOCAL1 = 0xd5;
const SETLOCAL2 = 0xd6;
const PUSHSCOPE = 0x30;
const PUSHBYTE = 0x24;
const DUP = 0x2a;
const SWAP = 0x2b;
const KILL = 0x08;
const ADD = 0xa0;
const SUBTRACT = 0xa1;
const MULTIPLY = 0xa2;
const LESSTHAN = 0xad;
const COERCE_A = 0x82;
const CONVERT_I = 0x73;
const INCLOCAL_I = 0xc2;
const IFFALSE = 0x12;
const FINDPROPSTRICT = 0x5d;
const CALLPROPVOID = 0x4f;
const RETURNVOID = 0x47;
const TRACE = 1;

/** The script initializer `code`, after `l1 = 5; l2 = 7`, and what it traces. */
async function traced(code: number[]): Promise<string[]> {
  const body = {
    method: 0,
    code: [
      GETLOCAL0,
      PUSHSCOPE,
      PUSHBYTE,
      5,
      SETLOCAL1,
      PUSHBYTE,
      7,
      SETLOCAL2,
      ...code,
      RETURNVOID,
    ],
    maxStack: 6,
    localCount: 3,
    maxScopeDepth: 2,
  };
  const bytes = abc(pool, tables({ methods: [{}], scripts: [{ init: 0 }], bodies: [body] }));
  const builtins = ["builtin.abc", "shell_toplevel.abc"].map(
    (f) => new Uint8Array(readFileSync(new URL(f, generated))),
  );
  return runSwf2es(builtins, bytes);
}

/** `trace(<value>)` of the code that leaves one value on the stack. */
const trace = (value: number[]): number[] => [
  FINDPROPSTRICT,
  TRACE,
  ...value,
  CALLPROPVOID,
  TRACE,
  1,
];

test("a swap of a held value and a copy, whose local is set before either is read", {
  skip,
}, async () => {
  // (l1 + 3), l1, swap, l1 = 9, subtract: 5 - 8.
  const code = trace([
    GETLOCAL1,
    PUSHBYTE,
    3,
    ADD,
    GETLOCAL1,
    SWAP,
    PUSHBYTE,
    9,
    SETLOCAL1,
    SUBTRACT,
  ]);
  assert.deepEqual(await traced(code), ["-3"]);
});

test("a swap of a held value and a value written", { skip }, async () => {
  // int(*(7)), (l1 * 2), swap, subtract: 10 - 7; then l1 = 1 and the
  // other way round: (l2 - l1) - int(*(l1)).
  const code = [
    ...trace([PUSHBYTE, 7, COERCE_A, CONVERT_I, GETLOCAL1, PUSHBYTE, 2, MULTIPLY, SWAP, SUBTRACT]),
    ...trace([GETLOCAL2, GETLOCAL1, SUBTRACT, GETLOCAL1, COERCE_A, CONVERT_I, SWAP, SUBTRACT]),
  ];
  assert.deepEqual(await traced(code), ["3", "3"]);
});

test("a held value duplicated, then its local killed", { skip }, async () => {
  // (l1 * 2), dup, kill l1, add: 10 + 10.
  const code = trace([GETLOCAL1, PUSHBYTE, 2, MULTIPLY, DUP, KILL, 1, ADD]);
  assert.deepEqual(await traced(code), ["20"]);
});

test("a held value whose local is incremented before it is read", { skip }, async () => {
  // (l1 + 1), l1++, l1, add: 6 + 6.
  const code = trace([GETLOCAL1, PUSHBYTE, 1, ADD, INCLOCAL_I, 1, GETLOCAL1, ADD]);
  assert.deepEqual(await traced(code), ["12"]);
});

test("a held condition whose local is set before the branch", { skip }, async () => {
  // l1 < 6, l1 = 0, iffalse: taken only if 5 < 6 were false.
  const code = [
    GETLOCAL1,
    PUSHBYTE,
    6,
    LESSTHAN,
    PUSHBYTE,
    0,
    SETLOCAL1,
    IFFALSE,
    ...[7, 0, 0],
    ...trace([PUSHBYTE, 1]),
    ...trace([GETLOCAL1]),
  ];
  assert.deepEqual(await traced(code), ["1", "0"]);
});

test("a held value that reads the stack register a later push writes", { skip }, async () => {
  // int(*(12)) + int(*(30)), then int(*(100)) above it, add: 42 + 100.
  const code = trace([
    PUSHBYTE,
    12,
    COERCE_A,
    CONVERT_I,
    PUSHBYTE,
    30,
    COERCE_A,
    CONVERT_I,
    ADD,
    PUSHBYTE,
    100,
    COERCE_A,
    CONVERT_I,
    ADD,
  ]);
  assert.deepEqual(await traced(code), ["142"]);
});
