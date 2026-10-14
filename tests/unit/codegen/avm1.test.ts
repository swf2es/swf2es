import assert from "node:assert/strict";
import { test } from "node:test";
import { testing } from "./testing-module.ts";

// AVM1 action blocks assembled by hand, decoded by codegen's AVM1 decoder
// and flow (assembly/avm1/), as Flash and Ruffle read them.

/** An action: its opcode and, from 0x80, its operands' length and bytes. */
function act(op: number, ...operands: number[]): number[] {
  return op < 0x80 ? [op] : [op, operands.length & 0xff, operands.length >> 8, ...operands];
}

/** An action whose length says `length`, whatever follows. */
function actLength(op: number, length: number, ...bytes: number[]): number[] {
  return [op, length & 0xff, length >> 8, ...bytes];
}

const str = (s: string) => [...Buffer.from(s, "utf8"), 0];
const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const i32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

const dump = (...parts: number[][]) => testing.avm1Dump(new Uint8Array(parts.flat())).split("\n");
const one = (bytes: number[], offset = 0) =>
  testing.avm1Action(new Uint8Array(bytes), offset) as string;

const PUSH = 0x96;
const JUMP = 0x99;
const IF = 0x9d;
const TRACE = 0x26;
const POP = 0x17;
const END = 0x00;

test("knows the actions of SWF 3 to 10, and no others", () => {
  const ops = (testing.avm1Opcodes() as string).split("\n");
  assert.equal(ops.length, 100);
  assert.ok(ops.includes("0x00 End"));
  assert.ok(ops.includes("0x26 Trace"));
  assert.ok(ops.includes("0x69 Extends"));
  assert.ok(ops.includes("0x8e DefineFunction2"));
  assert.ok(ops.includes("0x9f GotoFrame2"));
  // FSCommand2 (Flash Lite) and StrictMode: Flash skips them as unknown.
  assert.ok(!ops.some((line) => line.startsWith("0x2d ") || line.startsWith("0x89 ")));
});

test("Push reads each value type, a double's words swapped", () => {
  const values = [
    ...[0, ...str("hi")],
    ...[1, 0x00, 0x00, 0xc0, 0x3f],
    2,
    3,
    ...[4, 2],
    ...[5, 1],
    ...[5, 0],
    ...[6, 0x00, 0x00, 0x04, 0x40, 0x00, 0x00, 0x00, 0x00],
    ...[7, ...i32(-7)],
    ...[8, 3],
    ...[9, ...u16(300)],
  ];
  assert.equal(
    one(act(PUSH, ...values)),
    `0 Push "hi" 1.5f null undefined r2 true false 2.5 -7i c3 C300 next ${values.length + 3}`,
  );
});

test("Push skips a value type it does not know, as Flash Player 9 does", () => {
  // Ruffle's read_push: 10 is skipped; the byte after the length is not read.
  assert.equal(one([PUSH, 3, 0, 2, 10, 3, 3]), "0 Push null undefined next 6");
});

test("an action's operands may run past its length; the next action is where the length says", () => {
  // Push's integer takes four bytes where the length gives one.
  assert.equal(one([...actLength(PUSH, 2, 7, 1, 0, 0, 0), POP]), "0 Push 1i next 5");
  // Ruffle's read_length_mismatch: the Add inside the pool's length is skipped.
  const lines = dump(actLength(0x88, 5, ...u16(1), ...str("a")), [0x0a, 0x0b]);
  assert.deepEqual(lines, ["region 0 block 0-9", "block 0", '0 ConstantPool "a"', "8 Subtract"]);
});

test("ConstantPool keeps the strings it could read", () => {
  assert.equal(
    one(act(0x88, ...u16(3), ...str("a"), ...str("bc"), 0x41)),
    '0 ConstantPool "a" "bc" next 11',
  );
});

test("the other actions' operands", () => {
  assert.equal(one(act(0x81, ...u16(7))), "0 GotoFrame 7 next 5");
  assert.equal(one(act(0x83, ...str("u"), ...str("_self"))), '0 GetUrl "u" "_self" next 11');
  assert.equal(one(act(0x87, 3)), "0 StoreRegister r3 next 4");
  assert.equal(one(act(0x8b, ...str("/a"))), '0 SetTarget "/a" next 6');
  assert.equal(one(act(0x8c, ...str("lbl"))), '0 GotoLabel "lbl" next 7');
  assert.equal(one(act(0x9a, 0x42)), "0 GetUrl2 0x42 next 4");
  // A method of 3 is read as none.
  assert.equal(one(act(0x9a, 0xc3)), "0 GetUrl2 0xc0 next 4");
  assert.equal(one(act(0x9f, 3, ...u16(2))), "0 GotoFrame2 play 1 bias 2 next 6");
  assert.equal(one(act(0x9f, 0)), "0 GotoFrame2 play 0 bias 0 next 4");
  assert.equal(one(act(0x9e)), "0 Call next 3");
});

test("DefineFunction's body follows its header, a region of its own", () => {
  // Ruffle's read_define_function.
  const lines = dump(
    [0x9b, 0x08, 0x00, 0x66, 0x6f, 0x6f, 0x00, 0x00, 0x00, 0x0a, 0x00],
    [0x96, 0x06, 0x00, 0x00, 0x74, 0x65, 0x73, 0x74, 0x00, 0x26, 0x00],
  );
  assert.deepEqual(lines, [
    "region 0 block 0-22",
    "block 0",
    '0 DefineFunction "foo" () body 11-21 region 1',
    "21 End",
    "region 1 function 11-21 from 0 at 0",
    "block 11",
    '11 Push "test"',
    "20 Trace",
  ]);
});

test("DefineFunction2's registers, flags and parameters", () => {
  const body = act(PUSH, 4, 1);
  const header = [
    ...str("f"),
    ...u16(2),
    4,
    ...u16(0x0105 | 0xfe00),
    ...[1, ...str("a")],
    ...[0, ...str("b")],
    ...u16(body.length),
  ];
  const lines = dump(act(0x8e, ...header), body);
  assert.deepEqual(lines.slice(0, 3), [
    "region 0 block 0-23",
    "block 0",
    '0 DefineFunction2 "f" registers 4 flags 0x0105 (r1="a", "b") body 18-23 region 1',
  ]);
  assert.deepEqual(lines.slice(3), [
    "region 1 function 18-23 from 0 at 0",
    "block 18",
    "18 Push r1",
  ]);
});

test("With goes into its body and, for undefined or null, past it", () => {
  // adl: with (undefined) and with (null) skip the body.
  const body = [...act(PUSH, 2), TRACE];
  const lines = dump(act(0x94, ...u16(body.length)), body, [POP]);
  assert.deepEqual(lines, [
    "region 0 block 0-11",
    "block 0",
    "0 With body 5-10",
    "block 5",
    "5 Push null",
    "9 Trace",
    "block 10",
    "10 Pop",
  ]);
});

test("a With's body that jumps back before it leaves it, in the same activation", () => {
  // adl: the scope is gone at the jump's target, and the With there opens
  // it again; no code runs after the With as its body ends.
  const body = [TRACE, ...act(JUMP, ...u16(0x10000 - 12))];
  const lines = dump([POP], act(0x94, ...u16(body.length)), body, [END]);
  assert.deepEqual(lines, [
    "region 0 block 0-13",
    "block 0",
    "0 Pop",
    "1 With body 6-12",
    "block 6",
    "6 Trace",
    "7 Jump -12 -> 0",
    "block 12",
    "12 End",
  ]);
});

test("Try's bodies run in its activation, a throw landing on the catch or the finally", () => {
  const tryBody = [TRACE];
  const catchBody = [POP, POP];
  const finallyBody = [TRACE];
  const sizes = [...u16(1), ...u16(2), ...u16(1)];
  // adl: code running off the try body runs the catch's bytes, and on into
  // the finally's.
  let lines = dump(act(0x8f, 7, ...sizes, 2), tryBody, catchBody, finallyBody, [END]);
  assert.deepEqual(lines, [
    "region 0 block 0-16",
    "block 0",
    "0 Try flags 7 r2 try 11-12 catch 12-14 finally 14-15",
    "block 11",
    "11 Trace",
    "block 12",
    "12 Pop",
    "13 Pop",
    "block 14",
    "14 Trace",
    "block 15",
    "15 End",
  ]);

  // No catch flag: a throw lands on the finally, past the catch's bytes,
  // which only code running off the try body runs.
  const jumpOver = act(JUMP, ...u16(2));
  lines = dump(
    act(0x8f, 2, ...u16(6), ...sizes.slice(2), ...str("e")),
    tryBody,
    jumpOver,
    catchBody,
    finallyBody,
    [END],
  );
  assert.deepEqual(lines, [
    "region 0 block 0-22",
    "block 0",
    '0 Try flags 2 "e" try 12-18 catch 18-20 finally 20-21',
    "block 12",
    "12 Trace",
    "13 Jump 2 -> 20",
    "block 20",
    "20 Trace",
    "block 21",
    "21 End",
  ]);
});

test("a Try shorter than its header has empty bodies, after it", () => {
  assert.deepEqual(dump(act(0x8f, 1, 0, 0), [TRACE]), [
    "region 0 block 0-7",
    "block 0",
    "0 Try flags 0 try 6-6 catch 6-6 finally 6-6",
    "block 6",
    "6 Trace",
  ]);
});

test("If and Jump start blocks; a jump past the end or before the start leaves", () => {
  const lines = dump(
    act(PUSH, 5, 1), // 0
    act(IF, ...u16(5)), // 5 -> 15
    act(JUMP, ...u16(0xfff6)), // 10 -> 5
    [TRACE], // 15
    act(IF, ...u16(100)), // 16 -> exit 121
    act(JUMP, ...u16(0x10000 - 100)), // 21 -> exit -74
  );
  assert.deepEqual(lines, [
    "region 0 block 0-26",
    "block 0",
    "0 Push true",
    "block 5",
    "5 If 5 -> 15",
    "block 10",
    "10 Jump -10 -> 5",
    "block 15",
    "15 Trace",
    "16 If 100 -> exit 121",
    "block 21",
    "21 Jump -100 -> exit -74",
  ]);
});

test("a jump into the middle of an action decodes from there", () => {
  // The Push's string holds a Trace: the jump lands on it.
  const lines = dump(act(JUMP, ...u16(4)), act(PUSH, 0, 0x26, 0x00), [END]);
  assert.deepEqual(lines, [
    "region 0 block 0-12",
    "block 0",
    "0 Jump 4 -> 9",
    "block 9",
    "9 Trace",
    "10 End",
  ]);
});

test("code that two actions fall into starts a block", () => {
  // The Push's last byte, a type it skips, is an Add the jump lands on:
  // both fall into the Trace.
  const lines = dump(
    act(PUSH, 2, 2, 2, 2, 2, 2, 0x0a), // 0
    [TRACE], // 10
    act(JUMP, ...u16(0x10000 - 7)), // 11 -> 9
  );
  assert.deepEqual(lines, [
    "region 0 block 0-16",
    "block 0",
    "0 Push null null null null null null",
    "block 9",
    "9 Add",
    "block 10",
    "10 Trace",
    "11 Jump -7 -> 9",
  ]);
});

test("a function's body that jumps back before its start stays in it, and opens itself again", () => {
  // The body jumps to the DefineFunction itself, which defines the same
  // region from inside it.
  const body = act(JUMP, ...u16(0x10000 - 13));
  const lines = dump(act(0x9b, ...str(""), ...u16(0), ...u16(body.length)), body, [END]);
  assert.deepEqual(lines, [
    "region 0 block 0-14",
    "block 0",
    '0 DefineFunction "" () body 8-13 region 1',
    "13 End",
    "region 1 function 8-13 from 0 at 0",
    "block 0",
    '0 DefineFunction "" () body 8-13 region 1',
    "block 8",
    "8 Jump -13 -> 0",
  ]);
});

test("WaitForFrame skips a count of actions, not bytes", () => {
  const lines = dump(
    act(0x8a, ...u16(2), 2), // 0, skips 6 and 10
    act(PUSH, 2), // 6
    [TRACE], // 10
    [POP], // 11
    act(0x8d, 9), // 12, skips past the end
    [END], // 16
  );
  assert.deepEqual(lines, [
    "region 0 block 0-17",
    "block 0",
    "0 WaitForFrame 2 skip 2 -> 11",
    "block 6",
    "6 Push null",
    "10 Trace",
    "block 11",
    "11 Pop",
    "12 WaitForFrame2 skip 9 -> exit 17",
    "block 16",
    "16 End",
  ]);
});

test("truncated actions end the block; unknown ones are skipped", () => {
  // An operand past the block's end.
  assert.equal(one(act(0x81, 1)), "0 GotoFrame truncated next 4");
  // A length past the end, even where nothing is read: Flash gives up on
  // the movie, whatever follows the block in the SWF.
  assert.equal(one(actLength(0x9e, 50)), "0 Call truncated next 3");
  assert.equal(one(actLength(JUMP, 50, 0, 0)), "0 Jump truncated next 5");
  assert.equal(one(actLength(0xa0, 50)), "0 0xa0 truncated next 3");
  assert.equal(one(actLength(0xa0, 1, 0)), "0 0xa0 next 4");
  // No room for the length: only the opcode was read.
  assert.equal(one([0x96, 0]), "0 Push truncated next 1");
  // A string without its zero; a body past the end.
  assert.equal(one(act(0x8b, 0x61)), "0 SetTarget truncated next 4");
  assert.equal(one(act(0x94, ...u16(9))), "0 With truncated next 5");

  assert.deepEqual(dump([0x01, 0x7f], act(0xa0, 1, 2), act(0x81, 1)), [
    "region 0 block 0-11",
    "block 0",
    "0 0x01",
    "1 0x7f",
    "2 0xa0",
    "7 GotoFrame truncated",
  ]);
});

test("an empty block has a region and no blocks", () => {
  assert.deepEqual(dump([]), ["region 0 block 0-0"]);
});

test("a block decodes the same whatever was decoded before", () => {
  const block = new Uint8Array([...act(PUSH, 0, ...str("x")), TRACE, ...act(JUMP, ...u16(0))]);
  const first = testing.avm1Dump(block);
  testing.avm1Dump(new Uint8Array([...act(0x88, ...u16(1), ...str("pool")), 0xff]));
  assert.equal(testing.avm1Dump(block), first);
});
