// AVM1's Number, Math, the global functions and AS2's class actions in node,
// each expectation what adl traces for the same code (the avm1-number,
// -math, -globals and -classes player cases trace them in Flash), where
// Ruffle's are not.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  escapeAvm1,
  parseIntAvm1,
  unescapeAvm1,
} from "../../../packages/runtime/dist/avm1/globals/global.js";
import { toRadix } from "../../../packages/runtime/dist/avm1/globals/number.js";
import {
  type Avm1Object,
  type Host,
  Runtime,
  type Value,
} from "../../../packages/runtime/dist/avm1/index.js";

const rt = new Runtime();
const lines: string[] = [];
const host: Host = { trace: (text) => lines.push(text), play() {}, stop() {}, halt() {} };
rt.realm.current = rt.activation([], [], {}, rt.newObject(), host);

function frame(version: number) {
  const cx = rt.activation([], [], {}, rt.newObject(), host);
  return { V: rt.version(version), cx };
}

/** `self.name(...args)`, as CallMethod calls it. */
function call(self: Value, name: string, args: Value[], version = 7): Value {
  const { V, cx } = frame(version);
  cx.st.push(...[...args].reverse(), args.length, self, name);
  V.callMethod(cx);
  return cx.st.pop();
}

test("toString's radixes write a number past an int as Flash's digits of -2^31", () => {
  assert.equal(toRadix(255, 16), "ff");
  assert.equal(toRadix(-3.75, 16), "-3");
  assert.equal(toRadix(1e20, 16), "-(0000000");
  assert.equal(toRadix(Number.NaN, 3), "-/.//./..././/0.0./0.");
  assert.equal(call(255, "toString", [37]), "255");
});

test("Math takes too few arguments as NaN up to SWF 6, and rounds a half up", () => {
  const math = rt.realm.Math;
  assert.ok(Number.isNaN(call(math, "min", [5], 6) as number));
  assert.equal(call(math, "min", [], 6), Number.POSITIVE_INFINITY);
  assert.equal(call(math, "round", [-2.5]), -2);
  assert.equal(call(math, "pow", [true], 7), 1);
});

test("escape and unescape go by bytes, unescape's read as a SWF 6's strings are", () => {
  assert.equal(escapeAvm1("a b+é", 6), "a%20b%2B%C3%A9");
  assert.equal(unescapeAvm1("a%20b+c%2Bd%e9%C3%A9%u00e9%zz", 6), "a b c+dꃩ00e9z");
  assert.equal(unescapeAvm1("%e9", 5), "é");
});

test("parseInt's prefixes, as Ruffle has them and adl agrees", () => {
  assert.equal(parseIntAvm1("0x  -10", undefined, false, 7), -16);
  assert.ok(Number.isNaN(parseIntAvm1("+0x10", undefined, false, 7)));
  assert.equal(parseIntAvm1("-0x10", 34, true, 7), 38182);
  assert.equal(parseIntAvm1("-010", undefined, false, 7), -8);
  assert.equal(parseIntAvm1("019", undefined, false, 7), 19);
});

test("Extends gives a prototype without its own constructor, and ImplementsOp counts once", () => {
  const { V, cx } = frame(7);
  const A = rt.realm.newFunction(cx, () => undefined, [], 0, 7);
  const B = rt.realm.newFunction(cx, () => undefined, [], 0, 7);
  V.extends(cx, A, B);
  const proto = B.own("prototype", 7)?.value as Avm1Object;
  assert.equal(proto.own("constructor", 7), undefined);
  assert.equal(proto.own("__constructor__", 7)?.value, A);

  const I1 = rt.realm.newFunction(cx, () => undefined, [], 0, 7);
  const I2 = rt.realm.newFunction(cx, () => undefined, [], 0, 7);
  cx.st.push(I1, 1, B);
  V.implementsOp(cx);
  cx.st.push(I2, 1, B);
  V.implementsOp(cx);
  const b = rt.realm.construct(B, [], 7);
  assert.equal(V.instanceOf(cx, I1, b), true);
  assert.equal(V.instanceOf(cx, I2, b), false);
  assert.equal(V.instanceOf(cx, A, b), true);
  assert.equal(V.castOp(cx, b, I2), null);

  lines.length = 0;
  V.extends(cx, 5, B);
  assert.deepEqual(lines, [
    "Parameters of primitive types are no longer coerced into the required type - Object.",
  ]);
});
