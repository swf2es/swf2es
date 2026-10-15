// The AVM1 runtime's values: numbers as AVM1 writes them (Ruffle's
// f64_to_string cases, and what adl traces at SWF 5 to 7), strings as
// numbers and values as conditions and strings by version, and the
// operations a module's code calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Halt,
  type Host,
  NotYet,
  numberToString,
  Runtime,
  stringOf,
  stringToNumber,
  toBoolean,
} from "../../../packages/runtime/dist/avm1/index.js";

test("numbers are written to 15 digits with Flash's exponents and its carry's bugs", () => {
  const cases: [number, string][] = [
    [0, "0"],
    [-0, "0"],
    [1, "1"],
    [7, "7"],
    [-2147483648, "-2147483648"],
    [2147483648, "2147483648"],
    [1.4, "1.4"],
    [1.5, "1.5"],
    [0.1, "0.1"],
    [-990.123, "-990.123"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [Number.NEGATIVE_INFINITY, "-Infinity"],
    [9.9999e14, "999990000000000"],
    [-9.9999e14, "-999990000000000"],
    [1e15, "1e+15"],
    [-1e15, "-1e+15"],
    [1e21, "1e+21"],
    [123456789012345680000, "1.23456789012346e+20"],
    [1e-5, "0.00001"],
    [-1e-5, "-0.00001"],
    [1e-7, "1e-7"],
    [0.999e-5, "9.99e-6"],
    [-0.999e-5, "-9.99e-6"],
    [0.19999999999999996, "0.2"],
    [-0.19999999999999996, "-0.2"],
    [100000.12345678912, "100000.123456789"],
    [-100000.12345678912, "-100000.123456789"],
    [0.8000000000000005, "0.800000000000001"],
    [-0.8000000000000005, "-0.800000000000001"],
    [0.8300000000000005, "0.83"],
    [1e-320, "9.99988867182684e-321"],
    [-Number.MAX_VALUE, "-1.79769313486231e+308"],
    [2.2250738585072014e-308, "2.2250738585072e-308"],
    [Number.MAX_VALUE, "1.79769313486231e+308"],
    [5e-324, "4.94065645841247e-324"],
    [9.999999999999998, "10"],
    [-9.999999999999998, "-10"],
    [9999999999999996, "1e+16"],
    [-9999999999999996, "-e+16"],
    [0.000009999999999999996, "1e-5"],
    [-0.000009999999999999996, "-10e-6"],
    [0.00009999999999999996, "0.0001"],
    [-0.00009999999999999996, "-0.0001"],
  ];

  for (const [n, text] of cases) {
    assert.equal(numberToString(n), text, String(n));
  }
});

test("a string is a number by the SWF's version: hex and octal from 6, 0 for none up to 4", () => {
  const cases: [string, number, number][] = [
    ["12", 6, 12],
    [" 12", 6, 12],
    ["12 ", 6, Number.NaN],
    ["1e3", 7, 1000],
    ["1.5", 5, 1.5],
    ["", 7, Number.NaN],
    ["0x10", 6, 16],
    ["0x10", 5, Number.NaN],
    ["-0x10", 6, Number.NaN],
    ["017", 6, 15],
    ["-017", 6, -15],
    ["018", 6, 18],
    ["017", 5, 17],
    ["0xffffffff", 6, -1],
    ["abc", 5, Number.NaN],
    ["abc", 4, 0],
    ["12abc", 4, 12],
    // A string with no digit, as adl reads it; Ruffle reads "." as 0.
    [".", 5, Number.NaN],
    ["-.", 6, Number.NaN],
    [".5", 6, 0.5],
    ["5.", 6, 5],
  ];

  for (const [text, version, n] of cases) {
    assert.equal(stringToNumber(text, version), n, `${JSON.stringify(text)} at ${version}`);
  }
});

test("a string is true by its number up to SWF 6, by its length from 7", () => {
  assert.equal(toBoolean("0", 6), false);
  assert.equal(toBoolean("a", 6), false);
  assert.equal(toBoolean("2", 6), true);
  assert.equal(toBoolean("0x1", 6), true);
  assert.equal(toBoolean("0x1", 5), false);
  assert.equal(toBoolean("0", 7), true);
  assert.equal(toBoolean("", 7), false);
  assert.equal(toBoolean(Number.NaN, 7), false);
  assert.equal(toBoolean(-0, 7), false);
  assert.equal(toBoolean(0.5, 7), true);
  assert.equal(toBoolean(undefined, 7), false);
  assert.equal(toBoolean(null, 6), false);
});

test("undefined is a string up to SWF 6, and a boolean 1 or 0 up to SWF 4", () => {
  assert.equal(stringOf(undefined, 6), "");
  assert.equal(stringOf(undefined, 7), "undefined");
  assert.equal(stringOf(true, 4), "1");
  assert.equal(stringOf(false, 4), "0");
  assert.equal(stringOf(true, 5), "true");
  assert.equal(stringOf(null, 6), "null");
  assert.equal(stringOf(-0, 6), "0");
});

test("the operations of a version are made once, and act through the activation's host", () => {
  const rt = new Runtime();
  const V = rt.version(6);
  assert.equal(rt.version(6), V);
  assert.equal(new Runtime().version(6), V);
  assert.notEqual(rt.version(7), V);

  const calls: unknown[][] = [];
  const target = {};
  const host: Host = {
    trace: (text) => calls.push(["trace", text]),
    play: (t) => calls.push(["play", t]),
    stop: (t) => calls.push(["stop", t]),
    halt: () => calls.push(["halt"]),
  };
  const cx = rt.activation([], [], target, rt.newObject(), host);
  V.trace(cx, undefined);
  V.trace(cx, "a\rb");
  V.play(cx);
  V.stop(cx);
  V.constantPool(cx, ["x"]);
  assert.deepEqual(cx.pool, ["x"]);
  assert.throws(() => V.halt(cx), Halt);
  assert.throws(() => V.notYet("GetVariable"), NotYet);
  assert.throws(() => V.tooLarge());
  assert.deepEqual(calls, [
    ["trace", "undefined"],
    ["trace", "a\rb"],
    ["play", target],
    ["stop", target],
    ["halt"],
  ]);
});
