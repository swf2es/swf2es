import assert from "node:assert/strict";
import { test } from "node:test";
import { abc, type Body, tables, u30 } from "./abc-builder.ts";
import { testing } from "./testing-module.ts";

// Multinames: 1 a (QName), 2 Multiname a, 3 attribute @a.
const pool = {
  strings: ["a"],
  namespaces: [[0x16, ...u30(0)]],
  nsSets: [[1]],
  multinames: [
    [0x07, ...u30(1), ...u30(1)],
    [0x09, ...u30(1), ...u30(1)],
    [0x0d, ...u30(1), ...u30(1)],
  ],
};

const s24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];

// Opcodes used below.
const LABEL = 0x09;
const JUMP = 0x10;
const IFTRUE = 0x11;
const LOOKUPSWITCH = 0x1b;
const PUSHBYTE = 0x24;
const PUSHSHORT = 0x25;
const PUSHSCOPE = 0x30;
const RETURNVOID = 0x47;
const CALLPROPERTY = 0x46;
const GETLOCAL = 0x62;
const GETLOCAL0 = 0xd0;
const NOP = 0x02;
const PUSHTRUE = 0x26;
const DEBUG = 0xef;

/** Decode one body; its lines without the "body" header. */
function decode(
  code: number[],
  exceptions: Body["exceptions"] = [],
  frame: Partial<Body> = {},
): string[] {
  const body: Body = { method: 0, code, exceptions, maxStack: 4, ...frame };
  const bytes = abc(pool, tables({ methods: [{}], scripts: [{ init: 0 }], bodies: [body] }));
  return (testing.codeDump(bytes) as string)
    .split("\n")
    .slice(1)
    .map((l) => l.trim());
}

const error = (code: number[], exceptions?: Body["exceptions"], frame?: Partial<Body>) =>
  decode(code, exceptions, frame).find((l) => l.startsWith("error"));

test("decodes each operand layout", () => {
  const lines = decode(
    [
      PUSHBYTE,
      0xff,
      PUSHSHORT,
      ...u30(0xffff),
      GETLOCAL,
      ...u30(300),
      CALLPROPERTY,
      ...u30(1),
      ...u30(2),
      DEBUG,
      1,
      ...u30(1),
      3,
      ...u30(0),
      RETURNVOID,
    ],
    [],
    { localCount: 301 },
  );
  assert.deepEqual(lines, [
    "0 pushbyte -1 0 0",
    "2 pushshort -1 0 0",
    "6 getlocal 300 0 0",
    "9 callproperty 1 2 0",
    "12 debug 1 1 3",
    "17 returnvoid 0 0 0",
    "unreachable 0",
  ]);
});

test("lookupswitch reaches every case, relative to the instruction", () => {
  // 2: lookupswitch default +14, 2 cases +15, +16 (11 bytes); 13..15 unreachable.
  const lines = decode([
    PUSHBYTE,
    0,
    LOOKUPSWITCH,
    ...s24(14),
    ...u30(1),
    ...s24(15),
    ...s24(16),
    0,
    0,
    0,
    RETURNVOID,
    RETURNVOID,
    RETURNVOID,
  ]);
  assert.deepEqual(lines, [
    "0 pushbyte 0 0 0",
    "2 lookupswitch 14 1 0 [15,16]",
    "16 returnvoid 0 0 0",
    "17 returnvoid 0 0 0",
    "18 returnvoid 0 0 0",
    "unreachable 3",
  ]);
});

test("unreachable bytes are never read, junk included", () => {
  assert.deepEqual(decode([RETURNVOID, 0xff, 0x00, 0x22]), ["0 returnvoid 0 0 0", "unreachable 3"]);
  assert.deepEqual(decode([JUMP, ...s24(1), 0xff, RETURNVOID]), [
    "0 jump 1 0 0",
    "5 returnvoid 0 0 0",
    "unreachable 1",
  ]);
});

test("reachable illegal opcodes, float ones included, are 1011", () => {
  assert.equal(error([0xff]), "error 1011");
  assert.equal(error([NOP, 0x22, ...u30(1), RETURNVOID]), "error 1011", "pushfloat");
  assert.equal(
    error([0x4d, ...u30(1), ...u30(0), RETURNVOID]),
    "error 1011",
    "callinterface is internal",
  );
});

test("u30 operands with a top bit set are 1107, except pushshort's", () => {
  assert.equal(error([GETLOCAL, ...u30(0x40000000), RETURNVOID]), "error 1107");
  assert.equal(error([PUSHSHORT, ...u30(0x40000000), RETURNVOID]), undefined);
});

test("instructions may not run past the code", () => {
  assert.equal(error([GETLOCAL]), "error 1012");
  assert.equal(error([LOOKUPSWITCH, ...s24(0), ...u30(1), ...s24(0)]), "error 1012");
});

test("control may not fall off the end", () => {
  assert.equal(error([NOP]), "error 1020");
  assert.equal(error([PUSHBYTE, 1]), "error 1020");
  assert.equal(
    error([PUSHTRUE, IFTRUE, ...s24(0)]),
    "error 1021",
    "a branch to the end is out of the code",
  );
});

test("branch targets stay in the code and back edges need a label", () => {
  assert.equal(error([JUMP, ...s24(100)]), "error 1021");
  assert.equal(error([NOP, JUMP, ...s24(-5)]), "error 1021", "back to a nop");
  assert.equal(error([LABEL, JUMP, ...s24(-5)]), undefined, "back to a label");
  assert.equal(
    error([PUSHTRUE, IFTRUE, ...s24(0), NOP, JUMP, ...s24(-5), RETURNVOID]),
    undefined,
    "back to an earlier forward target",
  );
});

test("a branch into the middle of an instruction is 1021", () => {
  // iftrue +1 lands on pushbyte's operand byte, which is also a returnvoid.
  assert.equal(
    error([PUSHTRUE, IFTRUE, ...s24(1), PUSHBYTE, RETURNVOID, RETURNVOID]),
    "error 1021",
  );
});

test("handlers are reached only from instructions that can throw", () => {
  // pushscope at 1 can throw inside [0, 2): the handler at 3 is decoded.
  assert.deepEqual(
    decode([GETLOCAL0, PUSHSCOPE, RETURNVOID, RETURNVOID], [[0, 2, 3, 0, 0]]).slice(-2),
    ["3 returnvoid 0 0 0", "unreachable 0"],
  );
  // Nothing in [0, 2) can throw: the handler's junk is never read.
  assert.deepEqual(decode([NOP, NOP, RETURNVOID, 0xff], [[0, 2, 3, 0, 0]]).slice(-1), [
    "unreachable 1",
  ]);
});

test("a loop header can throw, so it reaches its handlers", () => {
  // 0: label, 1: jump back to 0; the handler at 5 covers the label.
  assert.equal(error([LABEL, JUMP, ...s24(-5), RETURNVOID], [[0, 1, 5, 0, 0]]), undefined);
  assert.equal(error([LABEL, JUMP, ...s24(-5), 0xff], [[0, 1, 5, 0, 0]]), "error 1011");
});

test("handler ranges and catch names are checked before decoding", () => {
  const code = [GETLOCAL0, PUSHSCOPE, RETURNVOID, RETURNVOID];
  assert.equal(error(code, [[2, 1, 3, 0, 0]]), "error 1054", "to before from");
  assert.equal(error(code, [[0, 2, 1, 0, 0]]), "error 1054", "target before to");
  assert.equal(error(code, [[0, 2, 4, 0, 0]]), "error 1054", "target past the code");
  assert.equal(error(code, [[0, 2, 3, 0, 2]]), undefined, "a Multiname name");
  assert.equal(error(code, [[0, 2, 3, 0, 3]]), "error 1107", "an attribute name");
});
