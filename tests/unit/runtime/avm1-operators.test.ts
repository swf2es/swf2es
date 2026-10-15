// AVM1's operators by SWF version, each expectation what adl traces for
// the same action in a SWF of that version (the avm1-operators-swf* player
// cases trace them all in Flash), where Ruffle's are not.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Activation,
  type Host,
  NotYet,
  objects,
  Runtime,
  type Value,
} from "../../../packages/runtime/dist/avm1/index.js";

const rt = new Runtime();

/** What `trace` writes of `value` in a SWF of `version`. */
function traced(version: number, value: Value): string {
  const lines: string[] = [];
  const host: Host = { trace: (t) => lines.push(t), play() {}, stop() {}, halt() {} };
  rt.version(version).trace(new Activation([], [], {}, host), value);
  return lines[0];
}

test("ToNumber reads strings by version: 0 for none up to 4, hex and octal from 6", () => {
  const cases: [Value, number, string][] = [
    [undefined, 6, "0"],
    [undefined, 7, "NaN"],
    [null, 6, "0"],
    [null, 7, "NaN"],
    ["", 4, "0"],
    ["", 5, "NaN"],
    ["abc", 4, "0"],
    ["12abc", 4, "12"],
    ["12abc", 5, "NaN"],
    ["1e", 6, "1"],
    ["0x1A", 5, "NaN"],
    ["0x1A", 6, "26"],
    ["-0x10", 6, "NaN"],
    ["012", 5, "12"],
    ["012", 6, "10"],
    ["0xFFFFFFFF", 6, "-1"],
    ["07777777777777", 6, "-1"],
    ["\t5", 6, "5"],
    ["\v5", 6, "NaN"],
    [" 5", 6, "NaN"],
    ["Infinity", 7, "NaN"],
    // Ruffle reads "." as 0.
    [".", 5, "NaN"],
    [".", 4, "0"],
    ["-.5", 6, "-0.5"],
    ["0.0", 6, "0"],
    ["1e400", 6, "Infinity"],
  ];

  for (const [value, version, text] of cases) {
    const V = rt.version(version);
    assert.equal(V.toString(V.toNumber(value)), text, `${JSON.stringify(value)} at ${version}`);
  }
});

test("ToInteger is ToInt32, NaN and the infinities 0", () => {
  const V = rt.version(6);
  const cases: [Value, number][] = [
    [-2.5, -2],
    [2147483648, -2147483648],
    [4294967295, -1],
    [-2147483649, 2147483647],
    [1e21, -559939584],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    ["0x1A", 26],
  ];

  for (const [value, n] of cases) {
    assert.equal(V.toInteger(value), n, String(value));
  }
});

test("Add is numbers and Add2 joins strings, undefined 0 up to SWF 6", () => {
  assert.equal(rt.version(4).add("2", "3"), 5);
  assert.equal(rt.version(4).add("abc", 1), 1);
  assert.equal(rt.version(6).add2(undefined, 1), 1);
  assert.ok(Number.isNaN(rt.version(7).add2(undefined, 1) as number));
  assert.equal(rt.version(6).add2(1, "a"), "a1");
  assert.equal(rt.version(4).add2(true, "a"), "a1");
  assert.equal(rt.version(5).add2(true, "a"), "atrue");
  assert.equal(rt.version(6).add2("", undefined), "");
  assert.equal(rt.version(7).add2("", undefined), "undefined");
  assert.equal(rt.version(6).add2(null, true), 1);
});

test("a division by zero is #ERROR# in SWF 4, and its zero's sign does not count from 5", () => {
  assert.equal(rt.version(4).divide(0, 1), "#ERROR#");
  assert.equal(rt.version(4).divide("abc", 1), "#ERROR#");
  assert.equal(rt.version(4).divide(2, 1), 0.5);
  const V = rt.version(5);
  assert.equal(V.divide(0, 1), Number.POSITIVE_INFINITY);
  assert.equal(V.divide(-0, 1), Number.POSITIVE_INFINITY);
  assert.equal(V.divide(-0, -1), Number.NEGATIVE_INFINITY);
  assert.ok(Number.isNaN(V.divide(-0, 0) as number));
  assert.equal(V.divide(Number.NEGATIVE_INFINITY, 1), -0);
  assert.ok(Number.isNaN(V.modulo(0, 5)));
});

// The operations take their operands as the code pops them, the top first:
// `x < y` pushes x, then y, and is less2(y, x).
const lt = (version: number, x: Value, y: Value) => rt.version(version).less2(y, x);
const gt = (version: number, x: Value, y: Value) => rt.version(version).greater(y, x);

test("Equals and Less are numbers, Equals2 and Less2 ECMAScript's, all booleans even in SWF 4", () => {
  const V4 = rt.version(4);
  assert.equal(V4.equals("abc", 0), true);
  assert.equal(V4.equals(undefined, null), true);
  assert.equal(V4.less("abc", 1), false);
  assert.equal(V4.less(1, "abc"), true);
  assert.equal(V4.and(1, "2"), true);
  assert.equal(V4.not("abc"), true);
  assert.equal(traced(4, V4.equals(1, 1)), "1");

  const V6 = rt.version(6);
  assert.equal(V6.equals2(undefined, null), true);
  assert.equal(V6.equals2(0, undefined), false);
  assert.equal(V6.equals2("1", true), true);
  assert.equal(V6.equals2("0x10", 16), true);
  assert.equal(rt.version(5).equals2("0x10", 16), false);
  assert.equal(V6.equals2("NaN", Number.NaN), false);
  assert.equal(V6.strictEquals(1, "1"), false);
  assert.equal(lt(6, Number.NaN, 1), undefined);
  assert.equal(lt(6, "abc", 1), undefined);
  assert.equal(lt(6, 1, 2), true);
  assert.equal(gt(6, 1, 2), false);
  assert.equal(lt(6, "a", "b"), true);
  assert.equal(lt(6, "a", "B"), false);
  assert.equal(lt(6, undefined, null), false);
  assert.equal(lt(7, undefined, null), undefined);
});

test("Less2 and Greater have the empty string after every other", () => {
  assert.equal(lt(6, "1", ""), true);
  assert.equal(lt(6, "", "1"), false);
  assert.equal(gt(6, "1", ""), false);
  assert.equal(gt(6, "", "1"), true);
  assert.equal(lt(6, "", ""), false);

  // StringLess does not, but for a SWF 5 string from a byte 0x80 up.
  const V5 = rt.version(5);
  assert.equal(rt.version(6).stringLess("a", ""), true);
  assert.equal(V5.stringLess("", "\u00c3\u00a9"), false);
  assert.equal(V5.stringLess("\u00c3\u00a9", ""), false);
  assert.equal(V5.stringGreater("", "\u00c3\u00a9"), true);
  assert.equal(V5.stringGreater("\u00c3\u00a9", ""), true);
  assert.equal(V5.stringLess("z", "\u00c3\u00a9"), false);
});

test("NaN equals NaN in Equals2 and StrictEquals, as a NaN its own copy does in Flash", () => {
  const V = rt.version(7);
  assert.equal(V.equals2(Number.NaN, Number.NaN), true);
  assert.equal(V.strictEquals(Number.NaN, Number.NaN), true);
  assert.equal(V.equals(Number.NaN, Number.NaN), false);
});

test("bitwise actions take ToInt32, and >>> is signed in SWF 8 and 9", () => {
  const V = rt.version(7);
  assert.equal(V.bitAnd(-1, 4294967295), -1);
  assert.equal(V.bitLShift(33, 1), 2);
  assert.equal(V.bitRShift(1, -1), -1);
  assert.equal(V.bitURShift(0, -1), 4294967295);
  assert.equal(V.bitURShift(1, -1), 2147483647);
  assert.equal(rt.version(8).bitURShift(0, -1), -1);
  assert.equal(rt.version(9).bitURShift(1, 2147483648), 1073741824);
  assert.equal(rt.version(10).bitURShift(0, -1), 4294967295);
  assert.equal(V.bitOr(0, Number.NaN), 0);
  assert.equal(V.bitXor("5", 1e21), -559939579);
});

test("SWF 5 strings are bytes: the char actions take bytes and the log writes them as UTF-8", () => {
  const V5 = rt.version(5);
  assert.equal(V5.asciiToChar(1000), "è");
  assert.equal(V5.asciiToChar(256), "");
  assert.equal(V5.mbAsciiToChar(321), "\u0001A");
  assert.equal(V5.mbAsciiToChar(256), "\u0001");
  assert.equal(V5.mbAsciiToChar(0xc3a9), "Ã©");
  assert.equal(V5.mbCharToAscii("Ã©"), 0xc3);
  assert.equal(V5.stringLength("Ã©"), 2);
  assert.equal(traced(5, "Ã©"), "é");
  assert.equal(traced(5, "ä¸A"), "�A");
  assert.equal(traced(5, "À\u0080"), "��");
  assert.equal(traced(5, "ï»¿A"), "﻿A");
  assert.equal(traced(6, "Ã©"), "Ã©");

  const V6 = rt.version(6);
  assert.equal(V6.asciiToChar(1000), "Ϩ");
  assert.equal(V6.asciiToChar(0xd800), "�");
  assert.equal(V6.charToAscii("😀"), 0xfffd);
  assert.equal(V6.stringLength("😀"), 2);
  assert.equal(V6.mbStringLength("中"), 1);
  assert.equal(V6.charToAscii(""), 0);
});

test("StringExtract counts from 1, a start below it the first, a count below 0 the rest", () => {
  const V = rt.version(6);
  assert.equal(V.stringExtract(2, 0, "abcdef"), "ab");
  assert.equal(V.stringExtract(2, 2, "abcdef"), "bc");
  assert.equal(V.stringExtract(-1, 2, "abcdef"), "bcdef");
  assert.equal(V.stringExtract(10, 6, "abcdef"), "f");
  assert.equal(V.stringExtract(1, 7, "abcdef"), "");
  assert.equal(V.stringExtract(1.5, 2.7, "abcdef"), "b");
  assert.equal(V.stringExtract(Number.NaN, "3", "abcdef"), "");
  // The start is index - 1 in 32 bits: -2^31 wraps to 2^31 - 1, past the end.
  assert.equal(V.stringExtract(2, -2147483647, "abcdef"), "ab");
  assert.equal(V.stringExtract(2, -2147483648, "abcdef"), "");
  assert.equal(V.stringExtract(2, 6442450944, "abcdef"), "");
  assert.equal(V.stringExtract(2, 4294967296, "abcdef"), "ab");
  assert.equal(V.mbStringExtract(undefined, undefined, 12345), "");

  // From SWF 6 each half of a pair cut is U+FFFD; up to 5 a string is bytes.
  assert.equal(V.stringExtract(1, 2, "a😀b"), "\ufffd");
  assert.equal(V.mbStringExtract(2, 3, "a😀b"), "\ufffdb");
  assert.equal(V.stringExtract(2, 2, "😀😀"), "\ufffd\ufffd");
  assert.equal(V.stringExtract(2, 2, "a😀b"), "😀");
  assert.equal(rt.version(5).stringExtract(1, 2, "a\ud83d\ude00b"), "\ud83d");
});

test("an object's conversions are the later steps': until then they end the block", () => {
  const V = rt.version(6);
  const object = {};
  assert.throws(() => V.toNumber(object), NotYet);
  assert.throws(() => V.add2(object, 1), NotYet);
  assert.throws(() => V.toString(object), NotYet);
  assert.equal(V.toBoolean(object), true);

  const saved = { ...objects };
  try {
    Object.assign(objects, {
      valueOf: () => 2,
      toPrimitive: () => "p",
      toString: () => "s",
      typeOf: () => "object",
    });
    assert.equal(V.toNumber(object), 2);
    assert.equal(V.add2(object, 1), "1p");
    assert.equal(lt(6, object, 1), false);
    assert.equal(lt(6, 1, object), true);
    assert.equal(V.equals2(object, 2), true);
    assert.equal(V.typeOf(object), "object");
    assert.equal(V.stringAdd(object, "a"), "as");
  } finally {
    Object.assign(objects, saved);
  }
});
