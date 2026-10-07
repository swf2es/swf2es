import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { s24, script } from "./ir-cases.ts";
import { testing } from "./testing-module.ts";

const generated = new URL("../../../oracle/avmplus/generated/", import.meta.url);
const skip = !existsSync(generated) && "oracle/avmplus missing";

/** The IR of the ABC's script initializer, as lines. */
function ir(abc: Uint8Array): string[] {
  testing.domainReset(50);
  testing.domainAdd(new Uint8Array(readFileSync(new URL("builtin.abc", generated))), true);
  assert.equal(testing.domainAdd(abc, false), 0);
  return (testing.domainIr(0) as string).split("\n");
}

const PUSHBYTE = 0x24;
const PUSHTRUE = 0x26;
const IFTRUE = 0x11;
const JUMP = 0x10;
const POP = 0x29;
const ADD = 0xa0;
const RETURNVOID = 0x47;
const GETLOCAL0 = 0xd0;
const GETLOCAL1 = 0xd1;
const GETLOCAL2 = 0xd2;
const SETLOCAL1 = 0xd5;
const SETLOCAL2 = 0xd6;
const SETLOCAL3 = 0xd7;
const PUSHSCOPE = 0x30;
const FINDPROPERTY = 0x5e;
const INITPROPERTY = 0x68;
const GETLEX = 0x60;

test("locals and the stack are registers, typed as the verifier types them", { skip }, () => {
  const code = [PUSHBYTE, 1, SETLOCAL1, PUSHBYTE, 2, SETLOCAL2, GETLOCAL1, GETLOCAL2, ADD];
  assert.deepEqual(ir(script([...code, SETLOCAL3, RETURNVOID])), [
    "B0 @0 stack [] scope []",
    "  0: s0 = pushbyte [1 0 0] : int!",
    "  2: l1 = setlocal1 s0 : int!",
    "  3: s0 = pushbyte [2 0 0] : int!",
    "  5: l2 = setlocal2 s0 : int!",
    "  6: s0 = getlocal1 l1 : int!",
    "  7: s1 = getlocal2 l2 : int!",
    "  8: s0 = add s0 s1 : Number!",
    "  9: l3 = setlocal3 s0 : Number!",
    "  10: returnvoid",
  ]);
});

test("branches name blocks, which keep the state they are entered with", { skip }, () => {
  // 1: iftrue +6 to 11; 7: jump +2 to 13; both paths push an int.
  const code = [PUSHTRUE, IFTRUE, ...s24(6), PUSHBYTE, 1, JUMP, ...s24(2), PUSHBYTE, 2];
  assert.deepEqual(ir(script([...code, POP, RETURNVOID])), [
    "B0 @0 stack [] scope []",
    "  0: s0 = pushtrue : Boolean!",
    "  1: iftrue s0 B1",
    "  5: s0 = pushbyte [1 0 0] : int!",
    "  7: jump B2",
    "B1 @11 stack [] scope []",
    "  11: s0 = pushbyte [2 0 0] : int!",
    "B2 @13 stack [int!] scope []",
    "  13: pop s0",
    "  14: returnvoid",
  ]);
});

test("a script's own global is found statically, and its slots bind early", { skip }, () => {
  const code = [GETLOCAL0, PUSHSCOPE, FINDPROPERTY, 1, PUSHBYTE, 5, INITPROPERTY, 1, GETLEX, 1];
  assert.deepEqual(ir(script([...code, POP, RETURNVOID], {}, [{ name: 1, kind: 0 }])), [
    "B0 @0 stack [] scope []",
    "  0: s0 = getlocal0 l0 : global!",
    "  1: sc0 = pushscope s0 : global!",
    "  2: s0 = getglobalscope : global!",
    "  4: s1 = pushbyte [5 0 0] : int!",
    "  6: setslot s0 s1",
    "  8: s0 = getglobalscope : global!",
    "  8: s0 = getslot s0 : *",
    "  10: pop s0",
    "  11: returnvoid",
  ]);
});

const PUSHNULL = 0x20;
const PUSHUNDEFINED = 0x21;
const IFFALSE = 0x12;
const IFEQ = 0x13;
const IFNE = 0x14;
const IFSTRICTEQ = 0x19;
const EQUALS = 0xab;
const NOT = 0x96;
const KILL = 0x08;
const GETPROPERTY = 0x66;
/** l1.x, popped: the local, untyped, needs a null check. */
const GET_X = [GETLOCAL1, GETPROPERTY, 1, POP];

/** How many null checks the IR of a script initializer with `code` has. */
function checks(code: number[], frame = {}): number {
  return ir(script(code, frame)).filter((line) => line.includes("checknull")).length;
}

test("a local checked on every path since it was set needs no check again", { skip }, () => {
  assert.equal(checks([...GET_X, ...GET_X, RETURNVOID]), 1);
  // 4: iftrue +4 to 9, past the first check, in both its branches.
  const branches = [PUSHTRUE, IFTRUE, ...s24(4), ...GET_X, ...GET_X, ...GET_X, RETURNVOID];
  assert.equal(checks([...GET_X, ...branches.slice(0, -1), RETURNVOID]), 1);
});

test("a local set, killed, or unchecked on some path in is checked again", { skip }, () => {
  assert.equal(checks([...GET_X, PUSHNULL, SETLOCAL1, ...GET_X, RETURNVOID]), 2);
  assert.equal(checks([...GET_X, KILL, 1, ...GET_X, RETURNVOID]), 2);
  // 1: iftrue +4 to 9, around the first check.
  assert.equal(checks([PUSHTRUE, IFTRUE, ...s24(4), ...GET_X, ...GET_X, RETURNVOID]), 2);
});

test("a local compared with null or tested true needs no check where that tells", { skip }, () => {
  // 2: ifeq +4 to 10, the end: if (l1 != null) l1.x
  assert.equal(checks([GETLOCAL1, PUSHNULL, IFEQ, ...s24(4), ...GET_X, RETURNVOID]), 0);
  // if (l1 == null) l1.x: only where it is null
  assert.equal(checks([GETLOCAL1, PUSHNULL, IFNE, ...s24(4), ...GET_X, RETURNVOID]), 1);
  // 4: iffalse +4 to 12: if (!(l1 == null)) l1.x
  const not = [GETLOCAL1, PUSHNULL, EQUALS, NOT, IFFALSE, ...s24(4), ...GET_X, RETURNVOID];
  assert.equal(checks(not), 0);
  // if (l1) l1.x
  assert.equal(checks([GETLOCAL1, IFFALSE, ...s24(4), ...GET_X, RETURNVOID]), 0);
  // if (!l1) l1.x; then l1.x where both ways in tell it is not null.
  assert.equal(checks([GETLOCAL1, IFTRUE, ...s24(4), ...GET_X, ...GET_X, RETURNVOID]), 1);
  // l1 !== null may still be undefined.
  assert.equal(checks([GETLOCAL1, PUSHNULL, IFSTRICTEQ, ...s24(4), ...GET_X, RETURNVOID]), 1);
  // l1 != undefined, pushed, tells as null does.
  assert.equal(checks([GETLOCAL1, PUSHUNDEFINED, IFEQ, ...s24(4), ...GET_X, RETURNVOID]), 0);
  // A value only typed void, as a native's :void result, may be anything:
  // l2 = undefined; if (l1 != l2) l1.x
  const typed = [PUSHUNDEFINED, SETLOCAL2, GETLOCAL1, GETLOCAL2, IFEQ, ...s24(4), ...GET_X];
  assert.equal(checks([...typed, RETURNVOID]), 1);
});

test("a handler sees a local as it was where its range threw", { skip }, () => {
  // 4: jump +5 to 13; 8: the handler, for the check in 0..4.
  const handled = [...GET_X, JUMP, ...s24(5), POP, ...GET_X, RETURNVOID];
  assert.equal(checks(handled, { exceptions: [[0, 4, 8, 0, 0]] }), 2);
  // Checked before the range: 8: jump +5 to 17; 12: the handler, for 4..8.
  const before = [...GET_X, ...GET_X, JUMP, ...s24(5), POP, ...GET_X, RETURNVOID];
  assert.equal(checks(before, { exceptions: [[4, 8, 12, 0, 0]] }), 1);
});
