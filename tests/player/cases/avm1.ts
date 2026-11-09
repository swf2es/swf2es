// The player's AVM1 cases (cases.ts): the language, clips, drawing,
// events, filters and the script limits, traced and drawn as Flash does.
import { readFileSync } from "node:fs";
import { tags, zlibCompress } from "../../../packages/format/dist/index.js";
import {
  type Avm1Assembler,
  byteString,
  constant,
  double,
  FunctionFlag,
  type PushValue,
  register,
  type SimpleAction,
  TryFlag,
} from "../../avm1-assembler.ts";
import { backwardSwf } from "../../avm1-backward.ts";
import { skippedExports } from "../../avm1-exports.ts";
import { maskSwf } from "../../avm1-masks.ts";
import { flashAssembler, script } from "../../avm1-script.ts";
import * as w from "../../swf-writer.ts";
import type { Compile } from "../scripts.ts";
import {
  type Avm1Expr,
  type Avm1Statement,
  as1,
  at,
  avm1,
  bare,
  block,
  body,
  code,
  label,
  op,
  type PlayerCase,
  square,
} from "./common.ts";

/** Values as AVM1 traces them, in adl: a number to 15 digits, with Flash's own exponents. */
const AVM1_VALUES = [
  undefined,
  null,
  true,
  false,
  7,
  double(-0),
  double(Number.NaN),
  double(Number.POSITIVE_INFINITY),
  double(Number.NEGATIVE_INFINITY),
  1e21,
  0.1,
  1.5,
  -990.123,
  1e-7,
  1e15,
  1e-5,
  123456789012345680000,
  0.8000000000000005,
  9.999999999999998,
  -9999999999999996,
  -0.000009999999999999996,
];

// An AVM1 SWF of version 6 (player/src/avm1/avm1.ts): frame 1's DoAction
// blocks share the operand stack and the constant pool, its DoInitAction
// runs before them though its tag comes after, and values trace as AVM1
// writes them; frame 2 finds the stack empty, traces and stops, so
// frame 1's actions never run again.
function avm1Hello(): Uint8Array {
  return w.swf({
    version: 6,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 2,
    tags: [
      w.backgroundColor(0xffffff),
      w.sprite(1, 1, [w.showFrame(), w.end()]),
      w.doAction(avm1((a) => a.push("left on the stack"))),
      w.doAction(avm1((a) => a.push("frame 1").trace().trace())),
      w.doAction(avm1((a) => a.constantPool("pooled"))),
      w.doAction(avm1((a) => a.push(constant(0)).trace())),
      w.doAction(avm1((a) => AVM1_VALUES.reduce((b, v) => b.push(v).trace(), a))),
      w.doInitAction(
        1,
        avm1((a) => a.push("init").trace()),
      ),
      w.showFrame(),
      w.doAction(avm1((a) => a.trace().push("frame 2").trace().stop())),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** Every pair of `values`, each pushed in turn, but NaN with NaN (see `avm1Operators`). */
function pairs(left: PushValue[], right: PushValue[] = left): [PushValue, PushValue][] {
  const nan = (v: PushValue) =>
    typeof v === "object" && v !== null && "value" in v && Number.isNaN(v.value);
  return left.flatMap((a) =>
    right.flatMap((b): [PushValue, PushValue][] => (nan(a) && nan(b) ? [] : [[a, b]])),
  );
}

/** A DoAction that traces `action` of each of `operands`, pushed in order. */
function traceEach(action: SimpleAction, operands: PushValue[][]): Uint8Array {
  return w.doAction(
    avm1((a) =>
      operands.reduce(
        (b, values) =>
          b
            .push(...values)
            .op(action)
            .trace(),
        a,
      ),
    ),
  );
}

const NAN = double(Number.NaN);

const INFINITY = double(Number.POSITIVE_INFINITY);

/** Values to convert, as SWF 4 to 10 read strings, numbers and their edges. */
const AVM1_CONVERTED: PushValue[] = [
  undefined,
  null,
  true,
  false,
  0,
  double(-0),
  1,
  double(-2.5),
  NAN,
  INFINITY,
  double(2147483648),
  double(4294967295),
  double(1e21),
  "",
  " 12",
  "12 ",
  "0x1A",
  "-0x10",
  "012",
  "1e3",
  ".",
  "abc",
  "\t5",
  "é",
  "😀",
  byteString(0xc3, 0xa9),
  byteString(0x80),
];

// What AVM1's arithmetic, comparison, logical, bitwise, string and
// conversion actions push in a SWF of `version`, as adl traces them: the
// conversions of each version (undefined and strings as numbers, hex from
// SWF 6, booleans as 1 and 0 up to 4), SWF 4's "#ERROR#" for a division by
// zero, Less2's undefined for NaN and its empty string after every other,
// >>> signed in SWF 8 and 9, and up to SWF 5 strings as bytes, which the
// log writes as UTF-8. A NaN is never compared with another: Flash has
// one equal to a copy of itself and not to another, which values cannot
// tell (docs/avm1.md).
function avm1Operators(version: number): Uint8Array {
  const arithmetic: PushValue[] = [
    undefined,
    null,
    true,
    0,
    double(-0),
    double(2.5),
    NAN,
    INFINITY,
    "",
    "2",
    "abc",
    "0x10",
  ];
  const divisors: PushValue[] = [undefined, true, 0, double(-0), 2, "3", "abc", "0x10"];
  const compared: PushValue[] = [undefined, null, true, 0, 1, NAN, "", "1", "abc", "0x1"];
  const strings: PushValue[] = ["", "a", "B", "ab", "é", "中", byteString(0x80)];
  const codes = [0, 65, 233, 256, 321, 1000, 0xc3a9, 0xd800, 65535, 65601, -191];
  const shifted: [PushValue, PushValue][] = [
    [-1, 0],
    [-1, 1],
    [-1, 31],
    [-1, 32],
    [-1, 33],
    [double(2147483648), 0],
    [double(4294967295), 1],
    [double(1e21), 0],
    [double(1.9), 1],
    [double(-1.9), 1],
    [NAN, 1],
    [INFINITY, 1],
    ["0x80000000", 1],
    [5, -1],
    [1, 31],
  ];
  const extracted: [PushValue, PushValue][] = [
    [0, 2],
    [1, 2],
    [2, 2],
    [-1, -1],
    [2, -1],
    [6, 10],
    [7, 1],
    [double(2.7), double(1.5)],
    ["3", NAN],
    [undefined, undefined],
    [double(-2147483648), 2],
  ];
  const unary = (action: SimpleAction, values: PushValue[]) =>
    traceEach(
      action,
      values.map((v) => [v]),
    );
  const binary = (action: SimpleAction, operands: [PushValue, PushValue][]) =>
    traceEach(action, operands);

  return w.swf({
    version,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 1,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      ...(
        ["ToNumber", "ToString", "ToInteger", "Not", "Increment", "Decrement", "TypeOf"] as const
      ).map((action) => unary(action, AVM1_CONVERTED)),
      ...(["StringLength", "MBStringLength", "CharToAscii", "MBCharToAscii"] as const).map(
        (action) => unary(action, [...strings, 7, true, undefined]),
      ),
      ...(["AsciiToChar", "MBAsciiToChar"] as const).map((action) => unary(action, codes)),
      w.doAction(
        avm1((a) =>
          codes.reduce((b, c) => b.push(c).op("MBAsciiToChar").op("StringLength").trace(), a),
        ),
      ),
      ...(["Add", "Add2", "Subtract", "Multiply", "Divide", "Modulo"] as const).map((action) =>
        binary(action, pairs(arithmetic, divisors)),
      ),
      ...(
        ["Equals", "Equals2", "StrictEquals", "Less", "Less2", "Greater", "And", "Or"] as const
      ).map((action) => binary(action, pairs(compared))),
      // Whether a comparison pushes a boolean, even in SWF 4.
      w.doAction(
        avm1((a) =>
          (["Equals", "Less", "And", "StringEquals"] as const)
            .reduce((b, action) => b.push(1, 1).op(action).op("TypeOf").trace(), a)
            .push(1)
            .op("Not")
            .op("TypeOf")
            .trace(),
        ),
      ),
      ...(["StringAdd", "StringEquals", "StringLess", "StringGreater", "Less2"] as const).map(
        (action) => binary(action, pairs(strings)),
      ),
      ...(["BitAnd", "BitOr", "BitXor", "BitLShift", "BitRShift", "BitURShift"] as const).map(
        (action) => binary(action, shifted),
      ),
      ...(["StringExtract", "MBStringExtract"] as const).map((action) =>
        traceEach(
          action,
          ["abcdef", byteString(0xc3, 0xa9, 0x41)].flatMap((text) =>
            extracted.map(([index, count]) => [text, index, count]),
          ),
        ),
      ),
      // Each half of a surrogate pair StringExtract cuts is U+FFFD from SWF 6,
      // when compared or joined: the halves joined again are not the pair.
      w.doAction(
        avm1((a) =>
          a
            .push("a😀b", 2, 1)
            .op("StringExtract")
            .push("a😀b", 3, 1)
            .op("StringExtract")
            .op("StringAdd")
            .op("PushDuplicate")
            .trace()
            .push("😀")
            .op("StringEquals")
            .trace()
            .push("a😀b", 3, 1)
            .op("MBStringExtract")
            .push(0xfffd)
            .op("AsciiToChar")
            .op("StringEquals")
            .trace()
            .push("😀😀", 2, 2)
            .op("StringExtract")
            .push("c")
            .op("StringAdd")
            .trace(),
        ),
      ),
      // PushDuplicate and StackSwap of the empty stack's undefined.
      w.doAction(
        avm1((a) =>
          a
            .push("a", "b")
            .op("StackSwap")
            .trace()
            .trace()
            .op("PushDuplicate")
            .op("TypeOf")
            .trace()
            .trace(),
        ),
      ),
      w.showFrame(),
      w.end(),
    ],
  });
}

const lit =
  (v: PushValue): Avm1Expr =>
  (a) =>
    a.push(v);

const getVar =
  (name: string): Avm1Expr =>
  (a) =>
    a.push(name).op("GetVariable");

const member =
  (o: Avm1Expr, name: string): Avm1Expr =>
  (a) =>
    o(a).push(name).op("GetMember");

/** Arguments as calls take them: the last first, then their count. */
const args = (a: Avm1Assembler, values: Avm1Expr[]) =>
  [...values]
    .reverse()
    .reduce((b, e) => e(b), a)
    .push(values.length);

const callMethod =
  (o: Avm1Expr, name: string | undefined, ...values: Avm1Expr[]): Avm1Expr =>
  (a) =>
    o(args(a, values)).push(name).op("CallMethod");

const callFunction =
  (name: string, ...values: Avm1Expr[]): Avm1Expr =>
  (a) =>
    args(a, values).push(name).op("CallFunction");

const newObject =
  (name: string, ...values: Avm1Expr[]): Avm1Expr =>
  (a) =>
    args(a, values).push(name).op("NewObject");

const initObject =
  (...pairs: [string, Avm1Expr][]): Avm1Expr =>
  (a) =>
    pairs
      .reduce((b, [name, e]) => e(b.push(name)), a)
      .push(pairs.length)
      .op("InitObject");

const initArray =
  (...elements: Avm1Expr[]): Avm1Expr =>
  (a) =>
    [...elements]
      .reverse()
      .reduce((b, e) => e(b), a)
      .push(elements.length)
      .op("InitArray");

const setVar =
  (name: string, e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a.push(name)).op("SetVariable");

const setMember =
  (o: Avm1Expr, name: string, e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(o(a).push(name)).op("SetMember");

const traceOf =
  (e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a).trace();

const note =
  (text: string): Avm1Statement =>
  (a) =>
    a.push(text).trace();

const drop =
  (e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a).pop();

let forInLabels = 0;

/** `for (k in o) trace(k)`, by Enumerate2: the names up to the terminator. */
const forIn =
  (o: Avm1Expr): Avm1Statement =>
  (a) => {
    const n = forInLabels++;
    return o(a)
      .op("Enumerate2")
      .label(`in${n}`)
      .op("PushDuplicate")
      .push(null)
      .op("Equals2")
      .if(`out${n}`)
      .trace()
      .jump(`in${n}`)
      .label(`out${n}`)
      .pop();
  };

/** `for (k in o)` the names joined in one line, so that a line stands for an enumeration. */
const keysOf =
  (o: Avm1Expr): Avm1Statement =>
  (a) => {
    const n = forInLabels++;
    a.push("k", "").op("SetVariable");
    return o(a)
      .op("Enumerate2")
      .label(`in${n}`)
      .op("PushDuplicate")
      .push(null)
      .op("Equals2")
      .if(`out${n}`)
      .push("k")
      .op("StackSwap")
      .push("k")
      .op("GetVariable")
      .op("StackSwap")
      .op("Add2")
      .push(" ")
      .op("Add2")
      .op("SetVariable")
      .jump(`in${n}`)
      .label(`out${n}`)
      .pop()
      .push("k")
      .op("GetVariable")
      .trace();
  };

const o = getVar("o");

const OBJECT_PROTO = member(getVar("Object"), "prototype");

// What AVM1's objects do in a SWF of `version`, as adl traces it
// (docs/avm1.md, "Objects"): for..in's order and its terminator, names by
// the version's case, ASSetPropFlags' attributes and version bits,
// addProperty, watch and __resolve with native functions, which are all a
// SWF can call before step 7 brings its own, delete, the prototypes of
// primitives, _global, Object, and variables and paths on the root.
function avm1Objects(version: number): Uint8Array {
  const v6 = version >= 6;
  return w.swf({
    version,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 1,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      // for..in: the last added first, a name deleted and set again last.
      block(
        note("-- enumeration"),
        setVar("o", initObject(["a", lit(1)], ["b", lit(2)])),
        setMember(o, "c", lit(3)),
        setMember(o, "d", lit(4)),
        traceOf(op("Delete", o, lit("b"))),
        setMember(o, "b", lit(5)),
        keysOf(o),
        // A prototype's names come first, but those the object has.
        setVar("p", initObject(["x", lit(1)], ["c", lit(2)], ["y", lit(3)])),
        setMember(o, "__proto__", getVar("p")),
        keysOf(o),
        setVar("q", initObject(["z", lit(1)])),
        setMember(getVar("q"), "__proto__", o),
        keysOf(getVar("q")),
        // The terminator, and an enumeration of no object.
        (a) => a.push("t").op("Enumerate").op("TypeOf").trace(),
        (a) => a.push(7).op("Enumerate2").op("TypeOf").trace(),
        keysOf(initArray(lit("a"), lit("b"), lit("c"))),
        keysOf(initObject(["10", lit(1)], ["2", lit(2)], ["1", lit(3)])),
        forIn(initObject(["only", lit(1)])),
      ),
      // Names by the version's case: up to SWF 6 the first spelling stays.
      block(
        note("-- case"),
        setVar("c", initObject()),
        setMember(getVar("c"), "Ab", lit(1)),
        setMember(getVar("c"), "aB", lit(2)),
        traceOf(member(getVar("c"), "ab")),
        traceOf(member(getVar("c"), "Ab")),
        traceOf(member(getVar("c"), "aB")),
        keysOf(getVar("c")),
        setVar("Vx", lit(7)),
        traceOf(getVar("vX")),
        traceOf(getVar("Vx")),
        traceOf(callMethod(getVar("c"), "HASOWNPROPERTY", lit("AB"))),
        traceOf(op("Delete", getVar("c"), lit("AB"))),
        keysOf(getVar("c")),
        ...(v6
          ? [
              setMember(getVar("c"), "é", lit(1)),
              traceOf(member(getVar("c"), "É")),
              setMember(getVar("c"), "ж", lit(2)),
              traceOf(member(getVar("c"), "Ж")),
            ]
          : []),
        traceOf(op("Equals2", getVar("THIS"), getVar("this"))),
      ),
      // ASSetPropFlags: don't enum 1, don't delete 2, read only 4, and the
      // bits that hide a property from SWFs before a version.
      block(
        note("-- flags"),
        setVar("f", initObject(["a", lit(1)], ["b", lit(2)], ["c", lit(3)], ["d", lit(4)])),
        drop(callFunction("ASSetPropFlags", getVar("f"), lit("a"), lit(1))),
        drop(callFunction("ASSetPropFlags", getVar("f"), lit("b,C"), lit(2))),
        drop(callFunction("ASSetPropFlags", getVar("f"), initArray(lit("d")), lit(4))),
        keysOf(getVar("f")),
        traceOf(op("Delete", getVar("f"), lit("b"))),
        traceOf(op("Delete", getVar("f"), lit("a"))),
        setMember(getVar("f"), "d", lit(40)),
        traceOf(member(getVar("f"), "d")),
        traceOf(callMethod(getVar("f"), "isPropertyEnumerable", lit("c"))),
        traceOf(callMethod(getVar("f"), "isPropertyEnumerable", lit("d"))),
        drop(callFunction("ASSetPropFlags", getVar("f"), lit(null), lit(0), lit(7))),
        keysOf(getVar("f")),
        // Every property, __proto__ and constructor included, shown.
        drop(callFunction("ASSetPropFlags", OBJECT_PROTO, lit(null), lit(0), lit(1))),
        keysOf(initObject()),
        drop(callFunction("ASSetPropFlags", OBJECT_PROTO, lit(null), lit(1))),
        setVar("g", initObject(["k", lit(1)])),
        drop(callFunction("ASSetPropFlags", getVar("g"), lit(null), lit(0), lit(1))),
        keysOf(getVar("g")),
        // The version bits.
        ...[0x80, 0x100, 0x400, 0x500, 0x1000, 0x2000, 0x4000, 0x8000].flatMap((bits) => [
          setVar("h", initObject(["v", lit(bits)])),
          drop(callFunction("ASSetPropFlags", getVar("h"), lit("v"), lit(bits))),
          traceOf(member(getVar("h"), "v")),
          traceOf(callMethod(getVar("h"), "hasOwnProperty", lit("v"))),
          keysOf(getVar("h")),
          setMember(getVar("h"), "v", lit("set")),
          traceOf(member(getVar("h"), "v")),
        ]),
        traceOf(op("TypeOf", getVar("Function"))),
        traceOf(op("TypeOf", member(initObject(), "watch"))),
        traceOf(op("TypeOf", member(initObject(), "toString"))),
      ),
      // addProperty, with natives as getter and setter.
      block(
        note("-- addProperty"),
        setVar("a", initObject(["s", lit(1)])),
        traceOf(callMethod(getVar("a"), "addProperty")),
        traceOf(callMethod(getVar("a"), "addProperty", lit("p"))),
        traceOf(callMethod(getVar("a"), "addProperty", lit(""), member(OBJECT_PROTO, "valueOf"))),
        traceOf(callMethod(getVar("a"), "addProperty", lit("p"), lit(5), lit(null))),
        traceOf(callMethod(getVar("a"), "addProperty", lit("p"), member(OBJECT_PROTO, "valueOf"))),
        traceOf(
          callMethod(getVar("a"), "addProperty", lit("p"), member(OBJECT_PROTO, "valueOf"), lit(7)),
        ),
        traceOf(op("TypeOf", member(getVar("a"), "p"))),
        traceOf(
          callMethod(
            getVar("a"),
            "addProperty",
            lit("p"),
            member(OBJECT_PROTO, "valueOf"),
            lit(null),
          ),
        ),
        traceOf(op("Equals2", member(getVar("a"), "p"), getVar("a"))),
        setMember(getVar("a"), "p", lit(9)),
        traceOf(op("Equals2", member(getVar("a"), "p"), getVar("a"))),
        traceOf(callMethod(getVar("a"), "hasOwnProperty", lit("p"))),
        keysOf(getVar("a")),
        // A getter or a setter that is an object but no function is refused.
        traceOf(callMethod(getVar("a"), "addProperty", lit("n"), initObject(), initObject())),
        traceOf(member(getVar("a"), "n")),
        traceOf(
          callMethod(
            getVar("a"),
            "addProperty",
            lit("n"),
            member(OBJECT_PROTO, "valueOf"),
            initObject(),
          ),
        ),
        // A getter over a value, and a toString getter.
        traceOf(
          callMethod(
            getVar("a"),
            "addProperty",
            lit("s"),
            member(OBJECT_PROTO, "toString"),
            lit(null),
          ),
        ),
        traceOf(member(getVar("a"), "s")),
        // A getter on the prototype, seen through an object and a primitive.
        setVar("b", initObject()),
        setMember(getVar("b"), "__proto__", getVar("a")),
        traceOf(member(getVar("b"), "s")),
        setMember(getVar("b"), "s", lit("own")),
        traceOf(member(getVar("b"), "s")),
        traceOf(callMethod(getVar("b"), "hasOwnProperty", lit("s"))),
      ),
      // watch: what each call gives, and a native callback's value set.
      block(
        note("-- watch"),
        setVar("w", initObject(["x", lit(1)])),
        traceOf(callMethod(getVar("w"), "watch")),
        traceOf(callMethod(getVar("w"), "watch", lit("x"))),
        traceOf(callMethod(getVar("w"), "watch", lit("x"), lit(5))),
        traceOf(callMethod(getVar("w"), "watch", lit("x"), initObject())),
        traceOf(callMethod(getVar("w"), "watch", lit("x"), member(OBJECT_PROTO, "valueOf"))),
        setMember(getVar("w"), "x", lit(2)),
        traceOf(op("Equals2", member(getVar("w"), "x"), getVar("w"))),
        // A second watch replaces the first: Object called with the name boxes it.
        traceOf(callMethod(getVar("w"), "watch", lit("x"), getVar("Object"), lit("data"))),
        setMember(getVar("w"), "x", lit(3)),
        traceOf(member(getVar("w"), "x")),
        traceOf(op("TypeOf", member(getVar("w"), "x"))),
        traceOf(callMethod(getVar("w"), "unwatch", lit("X"))),
        traceOf(callMethod(getVar("w"), "unwatch", lit("x"))),
        traceOf(callMethod(getVar("w"), "unwatch")),
        setMember(getVar("w"), "x", lit(4)),
        traceOf(member(getVar("w"), "x")),
        // A name not set yet, then set through SetVariable's path.
        traceOf(callMethod(getVar("w"), "watch", lit("later"), getVar("Object"))),
        setVar("w.later", lit(1)),
        traceOf(member(getVar("w"), "later")),
        // A watched read-only property.
        drop(callFunction("ASSetPropFlags", getVar("w"), lit("later"), lit(4))),
        setMember(getVar("w"), "later", lit(2)),
        traceOf(member(getVar("w"), "later")),
      ),
      // __resolve: asked for a name the chain lacks, with the name.
      block(
        note("-- __resolve"),
        setVar("r", initObject(["here", lit("here")])),
        setMember(getVar("r"), "__resolve", getVar("Object")),
        traceOf(member(getVar("r"), "missing")),
        traceOf(op("TypeOf", member(getVar("r"), "missing"))),
        traceOf(member(getVar("r"), "here")),
        traceOf(callMethod(getVar("r"), "hasOwnProperty", lit("missing"))),
        setMember(getVar("r"), "__resolve", lit(5)),
        traceOf(member(getVar("r"), "missing")),
        setMember(getVar("r"), "__resolve", initObject()),
        traceOf(member(getVar("r"), "missing")),
        setMember(getVar("r"), "__resolve", member(OBJECT_PROTO, "toString")),
        traceOf(member(getVar("r"), "missing")),
        // On the prototype; and not for a conversion's valueOf.
        setVar("s", initObject()),
        setMember(getVar("s"), "__proto__", getVar("r")),
        traceOf(member(getVar("s"), "missing")),
        setVar("bare", callFunction("Object")),
        setMember(getVar("bare"), "__resolve", getVar("Object")),
        traceOf(op("Add2", getVar("bare"), lit(""))),
        traceOf(getVar("bare")),
        // Through the scope chain: a variable missing is not resolved.
        traceOf(op("TypeOf", getVar("noSuchVariable"))),
      ),
      // delete, Delete2, and variables at the root.
      block(
        note("-- delete"),
        setVar("d", initObject(["x", lit(1)])),
        traceOf(op("Delete", getVar("d"), lit("x"))),
        traceOf(op("Delete", getVar("d"), lit("x"))),
        traceOf(op("Delete", lit("str"), lit("length"))),
        traceOf(op("Delete", getVar("d"), lit("__proto__"))),
        traceOf(op("Delete", OBJECT_PROTO, lit("toString"))),
        setVar("gone", lit(1)),
        traceOf(op("Delete2", lit("gone"))),
        traceOf(op("Delete2", lit("gone"))),
        traceOf(op("TypeOf", getVar("gone"))),
        setVar("dd", initObject(["y", lit(2)])),
        traceOf(op("Delete2", lit("dd.y"))),
        traceOf(op("TypeOf", member(getVar("dd"), "y"))),
        (a) => a.push("loc", 1).op("DefineLocal"),
        traceOf(getVar("loc")),
        (a) => a.push("loc").op("DefineLocal2"),
        traceOf(getVar("loc")),
        (a) => a.push("loc2").op("DefineLocal2"),
        traceOf(op("TypeOf", getVar("loc2"))),
        traceOf(callMethod(getVar("this"), "hasOwnProperty", lit("loc2"))),
        // Paths to objects' properties.
        setVar("pa", initObject(["b", initObject(["c", lit("deep")])])),
        traceOf(getVar("pa.b.c")),
        traceOf(getVar("pa:b")),
        traceOf(getVar("pa.b:c")),
        setVar("pa.b.e", lit("set")),
        traceOf(member(member(getVar("pa"), "b"), "e")),
        setVar("nopath.x", lit(1)),
        traceOf(op("TypeOf", getVar("nopath"))),
        traceOf(getVar("this.loc")),
        traceOf(getVar(".x")),
      ),
      // The prototypes of primitives, which GetMember and CallMethod box.
      block(
        note("-- primitives"),
        traceOf(member(lit("abc"), "length")),
        traceOf(member(lit("abc"), "LENGTH")),
        traceOf(
          op("Equals2", member(lit("abc"), "__proto__"), member(getVar("String"), "prototype")),
        ),
        traceOf(op("Equals2", member(lit("abc"), "constructor"), getVar("String"))),
        traceOf(op("Equals2", member(lit(5), "__constructor__"), getVar("Number"))),
        traceOf(callMethod(lit(5), "toString")),
        traceOf(callMethod(lit(true), "toString")),
        traceOf(callMethod(lit("s"), "valueOf")),
        traceOf(op("TypeOf", callMethod(lit("s"), "valueOf"))),
        setMember(member(getVar("String"), "prototype"), "extra", lit("on String")),
        traceOf(member(lit("x"), "extra")),
        traceOf(member(lit(1), "extra")),
        setMember(member(getVar("Object"), "prototype"), "everywhere", lit("on Object")),
        traceOf(member(lit(1), "everywhere")),
        traceOf(member(lit(false), "everywhere")),
        setMember(lit("x"), "bar", lit(1)),
        traceOf(member(lit("x"), "bar")),
        traceOf(member(lit(undefined), "x")),
        traceOf(member(lit(null), "x")),
        traceOf(callMethod(lit("x"), "hasOwnProperty", lit("length"))),
        traceOf(callMethod(lit(1), "hasOwnProperty", lit("length"))),
        traceOf(op("Delete", member(getVar("Object"), "prototype"), lit("everywhere"))),
        traceOf(op("Delete", member(getVar("String"), "prototype"), lit("extra"))),
        traceOf(callMethod(lit(undefined), "toString")),
      ),
      // _global, Object and the builtins' conversions.
      block(
        note("-- global"),
        traceOf(op("TypeOf", getVar("_global"))),
        setMember(getVar("_global"), "gv", lit("global")),
        traceOf(getVar("gv")),
        setVar("gv", lit("root")),
        traceOf(getVar("gv")),
        traceOf(member(getVar("_global"), "gv")),
        traceOf(op("TypeOf", member(getVar("_global"), "__proto__"))),
        traceOf(op("Equals2", getVar("_global"), lit(null))),
        traceOf(op("TypeOf", getVar("Object"))),
        // A SWF 5 sees no prototype of a function.
        traceOf(op("TypeOf", member(getVar("Object"), "__proto__"))),
        traceOf(getVar("Object")),
        traceOf(getVar("NaN")),
        traceOf(getVar("o")),
        traceOf(op("TypeOf", newObject("Object"))),
        traceOf(op("TypeOf", callFunction("Object"))),
        traceOf(op("TypeOf", member(callFunction("Object"), "toString"))),
        traceOf(newObject("Object", lit("boxed"))),
        traceOf(op("TypeOf", newObject("Object", lit(5)))),
        traceOf(op("Add2", newObject("Object", lit(5)), lit(1))),
        traceOf(callFunction("Object", lit(true))),
        traceOf(callMethod(newObject("Object"), "hasOwnProperty", lit("constructor"))),
        traceOf(callMethod(newObject("Object"), "hasOwnProperty", lit("__constructor__"))),
        traceOf(callMethod(initObject(), "hasOwnProperty", lit("constructor"))),
        traceOf(callMethod(initObject(), "isPrototypeOf", initObject())),
        traceOf(callMethod(OBJECT_PROTO, "isPrototypeOf", initObject())),
        traceOf(callMethod(OBJECT_PROTO, "isPrototypeOf", lit("s"))),
        traceOf(initObject(["a", lit(1)])),
        traceOf(callMethod(initObject(), "toString")),
        traceOf(callMethod(getVar("Object"), "toString")),
        traceOf(op("Equals2", callMethod(o, "valueOf"), o)),
        traceOf(op("Add2", initObject(), lit(1))),
        traceOf(initArray(lit(1), lit(undefined), lit("c"))),
        traceOf(op("TypeOf", initArray())),
        traceOf(member(initArray(lit(1), lit(2)), "length")),
        // InitObject's later pairs are set first; a count out of range pops none.
        keysOf(initObject(["a", lit(1)], ["b", lit(2)], ["a", lit(3)])),
        traceOf(member(initObject(["a", lit(1)], ["b", lit(2)], ["a", lit(3)]), "a")),
        (a) => a.push("kept", -1).op("InitObject").op("TypeOf").trace().trace(),
        (a) => a.push("kept", -1).op("InitArray").op("TypeOf").trace().trace(),
        // Counts are truncated: -0.5 is 0, NaN none, 1.7 pairs one.
        (a) => a.push("kept", -0.5).op("InitObject").op("TypeOf").trace().trace(),
        (a) => a.push("kept", Number.NaN).op("InitArray").op("TypeOf").trace().trace(),
        (a) => a.push("kept", "a", 1, "b", 2, 1.7).op("InitObject").op("Enumerate2"),
        (a) => a.trace().trace().trace().trace().trace(),
      ),
      // Flash's lower case, ASSetPropFlags' bits as an int's low 16, and paths' first steps.
      block(
        note("-- more names"),
        ...(v6
          ? (
              [
                ["İ", "i"],
                ["ΑΣ", "ασ"],
                ["xς", "XΣ"],
                ["ß", "ẞ"],
                ["ა", "Ⴀ"],
                ["ɐ", "Ɐ"],
              ] as const
            ).map(([stored, asked]) => traceOf(member(initObject([stored, lit(stored)]), asked)))
          : []),
        setVar("h", initObject(["v", lit(1)])),
        drop(callFunction("ASSetPropFlags", getVar("h"), lit("v"), lit(65537))),
        traceOf(op("Delete", getVar("h"), lit("v"))),
        setVar("h", initObject(["v", lit(1)])),
        drop(callFunction("ASSetPropFlags", getVar("h"), lit("v"), lit(-65534))),
        traceOf(op("Delete", getVar("h"), lit("v"))),
        setVar("h", initObject()),
        setMember(getVar("h"), "__resolve", getVar("Object")),
        drop(callFunction("ASSetPropFlags", getVar("h"), lit("__resolve"), lit(0x4000))),
        traceOf(op("TypeOf", member(getVar("h"), "missing"))),
        setVar("px", lit("root's")),
        traceOf(getVar("_ROOT.px")),
        traceOf(getVar("THIS.px")),
        traceOf(getVar("_global.ASSetPropFlags")),
        setVar("_global.pg", lit("global's")),
        traceOf(member(getVar("_global"), "pg")),
        setVar("this.pt", lit(1)),
        traceOf(getVar("pt")),
        // An array's indices: up to SWF 6 the digits before anything else; its length by case.
        ...["3abc", "1.9", " +3", "4294967298"].flatMap((name) => [
          setVar("ar", initArray(lit("x"))),
          setMember(getVar("ar"), name, lit(1)),
          traceOf(member(getVar("ar"), "length")),
        ]),
        setVar("ar", initArray(lit("x"), lit("y"), lit("z"))),
        setMember(getVar("ar"), "LENGTH", lit(1)),
        keysOf(getVar("ar")),
        // A __PROTO__ where __proto__ was deleted.
        setVar("pr", initObject()),
        drop(callFunction("ASSetPropFlags", getVar("pr"), lit("__proto__"), lit(0), lit(2))),
        traceOf(op("Delete", getVar("pr"), lit("__proto__"))),
        setMember(getVar("pr"), "__PROTO__", initObject(["inherited", lit("yes")])),
        traceOf(member(getVar("pr"), "inherited")),
      ),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** `function name(params) { ... }`: DefineFunction. */
const defineFn =
  (name: string, params: string[], ...statements: Avm1Statement[]): Avm1Statement =>
  (a) =>
    a.defineFunction(name, params, body(...statements));

/** An anonymous function, which DefineFunction pushes. */
const fnExpr =
  (params: string[], ...statements: Avm1Statement[]): Avm1Expr =>
  (a) =>
    a.defineFunction("", params, body(...statements));

/** DefineFunction2, with its register count, flags and parameters' registers. */
const defineFn2 =
  (
    name: string,
    registers: number,
    flags: number,
    params: [string, number][],
    ...statements: Avm1Statement[]
  ): Avm1Statement =>
  (a) =>
    a.defineFunction2(name, registers, flags, params, body(...statements));

const fn2Expr =
  (
    registers: number,
    flags: number,
    params: [string, number][],
    ...statements: Avm1Statement[]
  ): Avm1Expr =>
  (a) =>
    a.defineFunction2("", registers, flags, params, body(...statements));

const ret =
  (e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a).op("Return");

const reg =
  (n: number): Avm1Expr =>
  (a) =>
    a.push(register(n));

const storeReg =
  (n: number, e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a).storeRegister(n).pop();

const local =
  (name: string, e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a.push(name)).op("DefineLocal");

const newMethod =
  (o: Avm1Expr, name: string | undefined, ...values: Avm1Expr[]): Avm1Expr =>
  (a) =>
    o(args(a, values)).push(name).op("NewMethod");

let ifLabels = 0;

/** `if (cond) { statements }`. */
const ifThen =
  (cond: Avm1Expr, ...statements: Avm1Statement[]): Avm1Statement =>
  (a) => {
    const skip = `skip${ifLabels++}`;
    return statements.reduce((b, s) => s(b), cond(a).op("Not").if(skip)).label(skip);
  };

const proto = (name: string) => member(getVar(name), "prototype");

/**
 * "root" for the root, else the value's type: the player's root is no clip
 * yet (docs/avm1.md, step 10), whose `typeof` is "movieclip".
 */
const kind =
  (e: Avm1Expr): Avm1Expr =>
  (a) => {
    const n = ifLabels++;
    return e(a)
      .op("PushDuplicate")
      .push("_root")
      .op("GetVariable")
      .op("StrictEquals")
      .if(`root${n}`)
      .op("TypeOf")
      .jump(`kind${n}`)
      .label(`root${n}`)
      .pop()
      .push("root")
      .label(`kind${n}`);
  };

// What AVM1 functions do in a SWF of `version`, as adl traces it
// (docs/avm1.md, "Functions and registers"): calls and what they give,
// the operand stack a body shares with its caller, `this` by how a
// function is called, closures, `arguments`, registers global and
// DefineFunction2's own with its preloads, Function's call and apply, new,
// super, getters, setters, watchers and __resolve that are functions, the
// recursion limits, and the constant pool a function reads.
function avm1Functions(version: number): Uint8Array {
  // The root's _parent is left out: adl loads the SWF, whose root has one there.
  const all =
    FunctionFlag.preloadThis |
    FunctionFlag.preloadArguments |
    FunctionFlag.preloadSuper |
    FunctionFlag.preloadRoot |
    FunctionFlag.preloadGlobal;
  const describe = [
    traceOf(kind(reg(1))),
    traceOf(kind(getVar("this"))),
    traceOf(op("Equals2", getVar("this"), o)),
    traceOf(op("Equals2", getVar("this"), getVar("_root"))),
    traceOf(op("TypeOf", getVar("arguments"))),
    traceOf(op("TypeOf", getVar("super"))),
  ];
  return w.swf({
    version,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 3,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      block(
        note("-- calls"),
        defineFn(
          "add",
          ["a", "b"],
          traceOf(getVar("a")),
          traceOf(getVar("b")),
          traceOf(member(getVar("arguments"), "length")),
          ret(op("Add2", getVar("a"), getVar("b"))),
        ),
        traceOf(callFunction("add", lit(1), lit(2))),
        traceOf(callFunction("add", lit(1))),
        traceOf(callFunction("add", lit(1), lit(2), lit(3))),
        defineFn("none", []),
        traceOf(callFunction("none")),
        traceOf(op("TypeOf", callFunction("none"))),
        traceOf(op("TypeOf", getVar("add"))),
        traceOf(getVar("add")),
        traceOf(op("TypeOf", member(getVar("add"), "prototype"))),
        traceOf(op("Equals2", member(proto("add"), "constructor"), getVar("add"))),
        traceOf(op("Equals2", member(proto("add"), "__proto__"), OBJECT_PROTO)),
        traceOf(op("Equals2", member(getVar("add"), "__proto__"), proto("Function"))),
        keysOf(getVar("add")),
        keysOf(proto("add")),
        traceOf(callMethod(getVar("add"), "hasOwnProperty", lit("prototype"))),
        setVar("anon", fnExpr(["x"], ret(op("Multiply", getVar("x"), lit(2))))),
        traceOf(callFunction("anon", lit(21))),
        traceOf(callFunction("noSuchFunction", lit(1))),
        setVar("num", lit(5)),
        traceOf(callFunction("num")),
        setVar("obj", initObject(["v", lit(1)])),
        traceOf(callMethod(getVar("obj"), "nope")),
        traceOf(callMethod(getVar("obj"), "v")),
        traceOf(op("TypeOf", newObject("noSuchClass"))),
        traceOf(op("TypeOf", newMethod(getVar("obj"), "nope"))),
        traceOf(op("TypeOf", newMethod(getVar("obj"), "v"))),
        traceOf(op("TypeOf", newMethod(lit(undefined), "x"))),
        traceOf(callMethod(getVar("add"), "", lit(2), lit(3))),
        traceOf(callMethod(getVar("add"), undefined, lit(4), lit(5))),
        setVar("made", newMethod(getVar("add"), "", lit(1), lit(1))),
        traceOf(op("TypeOf", getVar("made"))),
        setMember(
          getVar("obj"),
          "self",
          fnExpr([], ret(op("Equals2", getVar("this"), getVar("obj")))),
        ),
        traceOf(callFunction("obj.self")),
        traceOf(callMethod(getVar("obj"), "self")),
        traceOf(callFunction("obj:self")),
        setVar("thisOf", fnExpr([], ret(kind(getVar("this"))))),
        traceOf(callMethod(getVar("thisOf"), "")),
        traceOf(callFunction("thisOf")),
        traceOf(callMethod(getVar("obj"), "thisOf")),
        defineFn("Casey", [], ret(lit("casey"))),
        traceOf(callFunction("casey")),
        traceOf(callFunction("CASEY")),
      ),
      block(
        note("-- the stack"),
        defineFn("popper", [], (a) => a.trace().trace()),
        (a) => a.push("under1", "under2", 0, "popper").op("CallFunction").trace(),
        defineFn("leaver", [], (a) => a.push("left"), ret(lit("ret"))),
        (a) => a.push(0, "leaver").op("CallFunction").trace().trace(),
        defineFn("emptyReturn", [], (a) => a.op("Return")),
        (a) => a.push("callers", 0, "emptyReturn").op("CallFunction").trace().trace(),
        (a) => a.push("kept", "popped").op("Return").push("after return").trace(),
      ),
      block(note("-- after a block's return"), (a) => a.trace().trace()),
      block(
        note("-- this"),
        setVar("o", initObject()),
        setMember(
          o,
          "who",
          fnExpr(
            [],
            traceOf(op("Equals2", getVar("this"), o)),
            traceOf(op("Equals2", getVar("this"), getVar("_root"))),
            traceOf(kind(getVar("this"))),
            traceOf(kind(getVar("THIS"))),
          ),
        ),
        drop(callMethod(o, "who")),
        setVar("who", member(o, "who")),
        drop(callFunction("who")),
        setMember(
          o,
          "outer",
          fnExpr(
            [],
            defineFn("inner", [], ret(getVar("this"))),
            local("got", callFunction("inner")),
            traceOf(op("Equals2", getVar("got"), o)),
            traceOf(op("Equals2", getVar("got"), getVar("_root"))),
            traceOf(kind(getVar("got"))),
            traceOf(callMethod(getVar("got"), "hasOwnProperty", lit("got"))),
            traceOf(op("TypeOf", callMethod(getVar("this"), "inner"))),
          ),
        ),
        drop(callMethod(o, "outer")),
        setMember(OBJECT_PROTO, "me", fnExpr([], ret(op("TypeOf", getVar("this"))))),
        traceOf(callMethod(lit("s"), "me")),
        traceOf(callMethod(lit(5), "me")),
        traceOf(callMethod(lit(true), "me")),
        drop(op("Delete", OBJECT_PROTO, lit("me"))),
        setMember(o, "setThis", fnExpr([], setVar("this", lit(5)), traceOf(getVar("this")))),
        drop(callMethod(o, "setThis")),
      ),
      block(
        note("-- closures"),
        defineFn(
          "counter",
          ["n"],
          local("c", getVar("n")),
          ret(fnExpr([], setVar("c", op("Add2", getVar("c"), lit(1))), ret(getVar("c")))),
        ),
        setVar("c1", callFunction("counter", lit(10))),
        traceOf(callFunction("c1")),
        traceOf(callFunction("c1")),
        setVar("c2", callFunction("counter", lit(20))),
        traceOf(callFunction("c2")),
        traceOf(callFunction("c1")),
        traceOf(op("TypeOf", getVar("c"))),
        traceOf(getVar("c")),
        defineFn("locals", [], local("loc", lit(1)), setVar("glob", lit(2)), (a) =>
          a.push("loc2").op("DefineLocal2"),
        ),
        drop(callFunction("locals")),
        traceOf(op("TypeOf", getVar("loc"))),
        traceOf(op("TypeOf", getVar("loc2"))),
        traceOf(getVar("glob")),
        setVar("shadow", lit("root")),
        defineFn("shadower", ["shadow"], setVar("shadow", lit("param")), traceOf(getVar("shadow"))),
        drop(callFunction("shadower", lit("arg"))),
        traceOf(getVar("shadow")),
        defineFn("missing", ["shadow"], traceOf(getVar("shadow"))),
        drop(callFunction("missing")),
        defineFn("outerP", ["p"], ret(fnExpr([], ret(op("Add2", getVar("p"), getVar("shadow")))))),
        traceOf(callMethod(callFunction("outerP", lit("p:")), "")),
        // A SWF 5 function's named function is its clip's; any other variable stays its own.
        defineFn(
          "definesInner",
          [],
          defineFn("innerNamed", [], ret(lit("inner"))),
          local("innerLocal", lit(1)),
        ),
        drop(callFunction("definesInner")),
        traceOf(op("TypeOf", getVar("innerNamed"))),
        traceOf(op("TypeOf", getVar("innerLocal"))),
      ),
      block(
        note("-- arguments"),
        defineFn(
          "args",
          ["a"],
          traceOf(member(getVar("arguments"), "length")),
          traceOf(member(getVar("arguments"), "0")),
          traceOf(op("TypeOf", getVar("arguments"))),
          traceOf(op("Equals2", member(getVar("arguments"), "callee"), getVar("args"))),
          traceOf(member(getVar("arguments"), "caller")),
          traceOf(op("TypeOf", member(getVar("arguments"), "caller"))),
          traceOf(op("Equals2", member(getVar("arguments"), "__proto__"), proto("Array"))),
          traceOf(op("Equals2", member(getVar("arguments"), "constructor"), getVar("Array"))),
          keysOf(getVar("arguments")),
          traceOf(getVar("arguments")),
          setMember(getVar("arguments"), "0", lit("changed")),
          traceOf(getVar("a")),
          setVar("a", lit("a set")),
          traceOf(member(getVar("arguments"), "0")),
          traceOf(callMethod(getVar("arguments"), "hasOwnProperty", lit("callee"))),
          traceOf(callMethod(getVar("arguments"), "isPropertyEnumerable", lit("callee"))),
          traceOf(getVar("ARGUMENTS")),
        ),
        drop(callFunction("args", lit(1), lit(2))),
        defineFn("callsArgs", [], drop(callFunction("whoCalled"))),
        defineFn(
          "whoCalled",
          [],
          traceOf(op("Equals2", member(getVar("arguments"), "caller"), getVar("callsArgs"))),
          traceOf(op("TypeOf", member(getVar("arguments"), "caller"))),
        ),
        drop(callFunction("callsArgs")),
        drop(callFunction("whoCalled")),
        defineFn("argsTwice", [], ret(getVar("arguments"))),
        traceOf(op("Equals2", callFunction("argsTwice"), callFunction("argsTwice"))),
        defineFn("argsSet", [], setVar("arguments", lit("mine")), traceOf(getVar("arguments"))),
        drop(callFunction("argsSet")),
        defineFn(
          "argsDelete",
          [],
          traceOf(op("Delete2", lit("arguments"))),
          traceOf(op("TypeOf", getVar("arguments"))),
        ),
        drop(callFunction("argsDelete")),
        traceOf(op("TypeOf", getVar("arguments"))),
      ),
      block(
        note("-- registers"),
        storeReg(0, lit("g0")),
        storeReg(1, lit("g1")),
        storeReg(2, lit("g2")),
        storeReg(3, lit("g3")),
        storeReg(4, lit("g4")),
        traceOf(reg(0)),
        traceOf(reg(1)),
        traceOf(reg(2)),
        traceOf(reg(3)),
        traceOf(reg(4)),
        traceOf(reg(255)),
        (a) => a.push("stays").storeRegister(1).trace(),
        traceOf(reg(1)),
        defineFn("df1", [], traceOf(reg(1)), storeReg(2, lit("from df1")), traceOf(reg(0))),
        drop(callFunction("df1")),
        traceOf(reg(2)),
        defineFn2(
          "df2",
          3,
          0,
          [
            ["x", 1],
            ["y", 0],
          ],
          traceOf(reg(0)),
          traceOf(reg(1)),
          traceOf(reg(2)),
          traceOf(reg(3)),
          traceOf(getVar("y")),
          traceOf(op("TypeOf", getVar("x"))),
          storeReg(2, lit("own")),
          storeReg(3, lit("global 3")),
          storeReg(5, lit("none")),
          traceOf(reg(5)),
        ),
        drop(callFunction("df2", lit("X"), lit("Y"))),
        traceOf(reg(2)),
        traceOf(reg(3)),
        defineFn2(
          "df2past",
          2,
          0,
          [
            ["x", 4],
            ["y", 1],
          ],
          traceOf(reg(4)),
          traceOf(reg(1)),
          traceOf(op("TypeOf", getVar("x"))),
        ),
        drop(callFunction("df2past", lit("X"), lit("Y"))),
        defineFn2(
          "df2zero",
          0,
          0,
          [["x", 0]],
          traceOf(reg(0)),
          traceOf(reg(1)),
          traceOf(getVar("x")),
        ),
        drop(callFunction("df2zero", lit("X0"))),
        defineFn2(
          "fact",
          2,
          0,
          [["n", 1]],
          ifThen(op("Less2", reg(1), lit(2)), ret(lit(1))),
          ret(op("Multiply", reg(1), callFunction("fact", op("Decrement", reg(1))))),
        ),
        traceOf(callFunction("fact", lit(5))),
        defineFn2(
          "same",
          2,
          0,
          [
            ["a", 1],
            ["b", 1],
          ],
          traceOf(reg(1)),
        ),
        drop(callFunction("same", lit("A"), lit("B"))),
      ),
      block(
        note("-- preloads"),
        defineFn2(
          "pre",
          10,
          all,
          [["p", 7]],
          ...[1, 2, 3, 4, 5, 6, 7, 8].map((r) => traceOf(kind(reg(r)))),
          traceOf(op("Equals2", reg(1), o)),
          traceOf(op("Equals2", reg(5), getVar("_global"))),
          traceOf(member(reg(2), "length")),
          traceOf(reg(7)),
          ...describe,
        ),
        setMember(o, "pre", getVar("pre")),
        drop(callMethod(o, "pre", lit("P"))),
        // Without its own `this`, a function's is its caller's or its definer's.
        defineFn2(
          "noThis",
          2,
          FunctionFlag.suppressThis,
          [],
          traceOf(op("Equals2", getVar("this"), o)),
          traceOf(kind(getVar("this"))),
        ),
        setMember(o, "callsNoThis", fnExpr([], drop(callFunction("noThis")))),
        drop(callMethod(o, "callsNoThis")),
        setMember(
          o,
          "definesNoThis",
          fnExpr(
            [],
            ret(
              fn2Expr(
                2,
                FunctionFlag.suppressThis,
                [],
                traceOf(op("Equals2", getVar("this"), o)),
                traceOf(kind(getVar("this"))),
              ),
            ),
          ),
        ),
        drop(callMethod(callMethod(o, "definesNoThis"), "")),
        ...[
          FunctionFlag.preloadThis | FunctionFlag.suppressThis,
          FunctionFlag.suppressThis,
          FunctionFlag.preloadArguments | FunctionFlag.suppressArguments,
          FunctionFlag.suppressArguments,
          FunctionFlag.preloadSuper | FunctionFlag.suppressSuper,
          FunctionFlag.suppressSuper,
          FunctionFlag.preloadRoot,
          FunctionFlag.preloadParent,
          FunctionFlag.preloadGlobal,
        ].flatMap((flags) => [
          note(`flags ${flags}`),
          setMember(o, "flagged", fn2Expr(4, flags, [], ...describe)),
          drop(callMethod(o, "flagged")),
        ]),
      ),
      block(
        note("-- call and apply"),
        setVar(
          "ca",
          fnExpr(
            ["a", "b"],
            traceOf(op("Equals2", getVar("this"), o)),
            traceOf(op("TypeOf", getVar("this"))),
            traceOf(getVar("a")),
            traceOf(getVar("b")),
            traceOf(member(getVar("arguments"), "length")),
            traceOf(op("TypeOf", getVar("super"))),
            ret(lit("r")),
          ),
        ),
        traceOf(callMethod(getVar("ca"), "call", o, lit(1), lit(2))),
        traceOf(callMethod(getVar("ca"), "apply", o, initArray(lit(3), lit(4)))),
        traceOf(callMethod(getVar("ca"), "apply", o)),
        traceOf(callMethod(getVar("ca"), "apply", o, lit(5))),
        traceOf(
          callMethod(
            getVar("ca"),
            "apply",
            o,
            initObject(["length", lit(2)], ["0", lit("x")], ["1", lit("y")]),
          ),
        ),
        traceOf(callMethod(getVar("ca"), "call")),
        traceOf(callMethod(getVar("ca"), "call", lit(null), lit("n"))),
        traceOf(callMethod(getVar("ca"), "call", lit("str"))),
        traceOf(op("TypeOf", member(proto("Function"), "call"))),
        traceOf(op("TypeOf", member(proto("Function"), "apply"))),
        traceOf(callMethod(member(OBJECT_PROTO, "hasOwnProperty"), "call", o, lit("pre"))),
        traceOf(callMethod(member(proto("Function"), "call"), "call", getVar("ca"), o, lit("cc"))),
        keysOf(proto("Function")),
        traceOf(op("TypeOf", callFunction("Function"))),
        traceOf(op("TypeOf", member(callFunction("Function"), "__proto__"))),
        traceOf(op("Equals2", callFunction("Function", getVar("ca")), getVar("ca"))),
        traceOf(op("TypeOf", newObject("Function"))),
        traceOf(op("Equals2", newObject("Function", getVar("ca")), getVar("ca"))),
      ),
      block(
        note("-- new"),
        defineFn(
          "Point",
          ["x", "y"],
          setMember(getVar("this"), "x", getVar("x")),
          setMember(getVar("this"), "y", getVar("y")),
          ret(lit("ignored")),
        ),
        setVar("pt", newObject("Point", lit(1), lit(2))),
        traceOf(op("TypeOf", getVar("pt"))),
        traceOf(member(getVar("pt"), "x")),
        traceOf(op("Equals2", member(getVar("pt"), "__proto__"), proto("Point"))),
        traceOf(op("Equals2", member(getVar("pt"), "constructor"), getVar("Point"))),
        traceOf(op("Equals2", member(getVar("pt"), "__constructor__"), getVar("Point"))),
        keysOf(getVar("pt")),
        defineFn("RetObj", [], ret(initObject(["from", lit("returned")]))),
        traceOf(member(newObject("RetObj"), "from")),
        setMember(
          proto("Point"),
          "sum",
          fnExpr([], ret(op("Add2", member(getVar("this"), "x"), member(getVar("this"), "y")))),
        ),
        traceOf(callMethod(getVar("pt"), "sum")),
        setMember(getVar("Point"), "prototype", initObject(["kind", lit("replaced")])),
        traceOf(member(newObject("Point"), "kind")),
        setMember(o, "Ctor", getVar("Point")),
        traceOf(member(newMethod(o, "Ctor", lit(3), lit(4)), "x")),
        drop(callFunction("Point", lit("px"), lit("py"))),
        traceOf(getVar("x")),
      ),
      block(
        note("-- super"),
        defineFn(
          "Base",
          ["v"],
          traceOf(op("Add2", lit("Base "), getVar("v"))),
          setMember(getVar("this"), "base", getVar("v")),
        ),
        setMember(
          proto("Base"),
          "hello",
          fnExpr([], ret(op("Add2", lit("Base.hello "), member(getVar("this"), "name")))),
        ),
        defineFn(
          "Derived",
          ["v"],
          drop(callMethod(getVar("super"), undefined, op("Add2", getVar("v"), lit(1)))),
          traceOf(lit("Derived")),
        ),
        setMember(proto("Derived"), "__proto__", proto("Base")),
        setMember(proto("Derived"), "__constructor__", getVar("Base")),
        setMember(
          proto("Derived"),
          "hello",
          fnExpr([], ret(op("Add2", lit("Derived.hello "), callMethod(getVar("super"), "hello")))),
        ),
        setVar("d", newObject("Derived", lit(1))),
        traceOf(member(getVar("d"), "base")),
        setMember(getVar("d"), "name", lit("d")),
        traceOf(callMethod(getVar("d"), "hello")),
        defineFn("Third", [], drop(callMethod(getVar("super"), undefined)), traceOf(lit("Third"))),
        setMember(proto("Third"), "__proto__", proto("Derived")),
        setMember(proto("Third"), "__constructor__", getVar("Derived")),
        setMember(
          proto("Third"),
          "hello",
          fnExpr([], ret(op("Add2", lit("Third.hello "), callMethod(getVar("super"), "hello")))),
        ),
        setVar("t3", newObject("Third")),
        setMember(getVar("t3"), "name", lit("t3")),
        traceOf(callMethod(getVar("t3"), "hello")),
        setMember(proto("Base"), "prop", lit("base prop")),
        setMember(
          proto("Derived"),
          "peek",
          fnExpr(
            [],
            traceOf(op("TypeOf", getVar("super"))),
            traceOf(member(getVar("super"), "prop")),
            traceOf(op("TypeOf", member(getVar("super"), "peek"))),
            traceOf(op("TypeOf", member(getVar("super"), "hello"))),
            traceOf(op("Equals2", getVar("super"), getVar("this"))),
            traceOf(getVar("super")),
          ),
        ),
        drop(callMethod(getVar("d"), "peek")),
        defineFn(
          "plainSuper",
          [],
          traceOf(op("TypeOf", getVar("super"))),
          traceOf(callMethod(getVar("super"), "hello")),
        ),
        drop(callFunction("plainSuper")),
        setMember(getVar("d"), "own", fnExpr([], ret(callMethod(getVar("super"), "hello")))),
        traceOf(callMethod(getVar("d"), "own")),
        // A method found two prototypes up, and one a getter gives: up to SWF 6
        // its `super` is above `this`'s prototype, from SWF 7 above where it was found.
        setMember(proto("Base"), "inh", fnExpr([], ret(callMethod(getVar("super"), "hello")))),
        traceOf(callMethod(getVar("t3"), "inh")),
        drop(
          callMethod(
            proto("Base"),
            "addProperty",
            lit("viaGetter"),
            fnExpr([], ret(member(proto("Base"), "inh"))),
            lit(null),
          ),
        ),
        traceOf(callMethod(getVar("t3"), "viaGetter")),
      ),
      block(
        note("-- properties"),
        setVar("pp", initObject()),
        traceOf(
          callMethod(
            getVar("pp"),
            "addProperty",
            lit("v"),
            fnExpr([], ret(lit("got"))),
            fnExpr(
              ["x"],
              traceOf(op("Add2", lit("set "), getVar("x"))),
              setMember(getVar("this"), "stored", getVar("x")),
            ),
          ),
        ),
        traceOf(member(getVar("pp"), "v")),
        setMember(getVar("pp"), "v", lit(5)),
        traceOf(member(getVar("pp"), "stored")),
        setVar("wo", initObject(["x", lit(1)])),
        traceOf(
          callMethod(
            getVar("wo"),
            "watch",
            lit("x"),
            fnExpr(
              ["name", "old", "nu", "data"],
              traceOf(getVar("name")),
              traceOf(getVar("old")),
              traceOf(getVar("nu")),
              traceOf(getVar("data")),
              traceOf(op("Equals2", getVar("this"), getVar("wo"))),
              ret(op("Add2", getVar("nu"), lit(100))),
            ),
            lit("d"),
          ),
        ),
        setMember(getVar("wo"), "x", lit(2)),
        traceOf(member(getVar("wo"), "x")),
        traceOf(callMethod(getVar("wo"), "watch", lit("x"), fnExpr([]))),
        setMember(getVar("wo"), "x", lit(3)),
        traceOf(op("TypeOf", member(getVar("wo"), "x"))),
        setVar("rs", initObject()),
        setMember(
          getVar("rs"),
          "__resolve",
          fnExpr(["n"], ret(op("Add2", lit("resolved "), getVar("n")))),
        ),
        traceOf(member(getVar("rs"), "anything")),
        traceOf(callMethod(getVar("rs"), "method", lit(1))),
        setVar("count", lit(0)),
        setVar("rec", initObject()),
        drop(
          callMethod(
            getVar("rec"),
            "addProperty",
            lit("p"),
            fnExpr(
              [],
              setVar("count", op("Increment", getVar("count"))),
              ret(member(getVar("this"), "p")),
            ),
            lit(null),
          ),
        ),
        traceOf(member(getVar("rec"), "p")),
        traceOf(getVar("count")),
        setVar("count", lit(0)),
        setVar("ws", initObject()),
        drop(
          callMethod(
            getVar("ws"),
            "watch",
            lit("p"),
            fnExpr(
              ["n", "old", "v"],
              setVar("count", op("Increment", getVar("count"))),
              setMember(getVar("this"), "p", op("Add2", getVar("v"), lit(1))),
              ret(getVar("v")),
            ),
          ),
        ),
        setMember(getVar("ws"), "p", lit(0)),
        traceOf(member(getVar("ws"), "p")),
        traceOf(getVar("count")),
        // A native getter that reads itself: join of an array whose element it is.
        setVar("ja", initArray()),
        drop(
          callMethod(
            getVar("ja"),
            "addProperty",
            lit("0"),
            member(proto("Array"), "join"),
            lit(null),
          ),
        ),
        traceOf(member(getVar("ja"), "length")),
        traceOf(callMethod(getVar("ja"), "join")),
        traceOf(member(getVar("ja"), "0")),
      ),
      block(
        note("-- constant pool"),
        (a) => a.constantPool("pool A"),
        defineFn("poolFn", [], traceOf(lit(constant(0)))),
        (a) => a.constantPool("pool B"),
        drop(callFunction("poolFn")),
        traceOf(lit(constant(0))),
        defineFn("poolSetter", [], (a) => a.constantPool("in body"), traceOf(lit(constant(0)))),
        drop(callFunction("poolSetter")),
        traceOf(lit(constant(0))),
        drop(callFunction("poolSetter")),
      ),
      w.showFrame(),
      block(
        note("-- frame 2"),
        traceOf(reg(1)),
        traceOf(reg(3)),
        drop(callFunction("poolFn")),
        traceOf(callFunction("c1")),
        storeReg(1, lit("across blocks")),
      ),
      block(traceOf(reg(1))),
      block(
        note("-- recursion"),
        setVar("depth", lit(0)),
        defineFn(
          "deep",
          [],
          setVar("depth", op("Increment", getVar("depth"))),
          ifThen(op("Greater", getVar("depth"), lit(250)), traceOf(getVar("depth"))),
          drop(callFunction("deep")),
          traceOf(lit("unwound")),
        ),
        drop(callFunction("deep")),
        traceOf(lit("after deep")),
      ),
      block(note("the block after")),
      w.showFrame(),
      block(note("-- frame 3"), traceOf(getVar("depth"))),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A SWF of `version` whose frame runs avm1/<name>.as, compiled by
// tests/avm1-script.ts as Flash's compiler writes it (a constant pool,
// batched pushes, DefineFunction2 from SWF 7): the cases of the language's
// classes, too long to read as the assembler's calls.
function avm1Script(name: string, version: number): Uint8Array {
  const source = readFileSync(new URL(`../avm1/${name}.as`, import.meta.url), "utf8");
  return w.swf({
    version,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 1,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      w.doAction([...script(source, version)(flashAssembler()).end().bytes()]),
      w.showFrame(),
      w.end(),
    ],
  });
}

function avm1Drawing(version: number): Uint8Array {
  return w.swf({
    version,
    width: 200,
    height: 120,
    frameCount: 3,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      as1(
        `var d = createEmptyMovieClip("d", 1);
d.lineStyle(2, 0x223344); d.moveTo(10, 10); d.lineTo(80, 10); d.lineTo(80, 45);
d.lineStyle(4, 0x008800, 50); d.moveTo(100, 10); d.curveTo(180, 10, 180, 50);
d.lineStyle(); d.beginFill(0xcc3300, 50);
d.moveTo(10, 60); d.lineTo(70, 60); d.lineTo(70, 100); d.lineTo(10, 100); d.endFill();
d.lineStyle(2, 0x000080); d.beginFill(0xaaaa00);
d.moveTo(100, 65); d.curveTo(140, 35, 180, 65); d.lineTo(180, 100); d.lineTo(100, 100); d.endFill();`,
        version,
      ),
      w.showFrame(),
      w.showFrame(),
      as1(
        `d.clear();
d.lineTo(180, 110);
d.beginFill(0x336699); d.moveTo(20, 20); d.lineTo(60, 20);
d.lineTo(60, 60); d.lineTo(20, 60); d.endFill();
stop();`,
        version,
      ),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** A DefineSprite of the frames' tags, each frame ended by a ShowFrame. */
const avm1Sprite = (id: number, frames: Uint8Array[][]) =>
  w.sprite(id, frames.length, [...frames.flatMap((f) => [...f, w.showFrame()]), w.end()]);

function avm1ScaleRamp(): Uint8Array {
  return w.swf({
    version: 10,
    width: 100,
    height: 100,
    frameRate: 30,
    frameCount: 1,
    tags: [
      w.fileAttributes(false),
      w.backgroundColor(0xffffff),
      square(1, 0x00aa00, 1600),
      avm1Sprite(2, [[w.place({ depth: 1, character: 1 })]]),
      w.place({ depth: 1, character: 2, name: "bar", matrix: { tx: 200, ty: 200 } }),
      as1(
        `
bar._xscale = 0; bar._yscale = 0;
onEnterFrame = function() {
  if (bar._xscale < 100) { bar._xscale++; }
  if (bar._yscale < 100) { bar._yscale++; }
  if (bar._xscale == 100 && bar._yscale == 100) {
    trace("ready " + bar._xscale + " " + bar._yscale);
    delete onEnterFrame;
  }
};
stop();`,
        10,
      ),
      w.showFrame(),
      w.end(),
    ],
  });
}

/** An AVM1 SWF of `version`, its root's frames' tags after the definitions. */
function avm1Swf(version: number, defs: Uint8Array[], frames: Uint8Array[][]): Uint8Array {
  return w.swf({
    version,
    width: 100,
    height: 100,
    frameRate: 24,
    frameCount: frames.length,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      ...defs,
      ...frames.flatMap((f) => [...f, w.showFrame()]),
      w.end(),
    ],
  });
}

// A NaN used as a property's name in a SWF of `version`: an array's
// element read and written, an object holding both "0" and "NaN", what
// for-in lists, a deletion and a member of this. Windows' Flash Player (and
// AIR) name it "0" in a SWF 7's member actions, as a maze game's wall checks
// rely on, though hasOwnProperty still names it "NaN"; SWF 6 and 8 name it
// "NaN", as does Linux's plugin in all three.
function avm1NanNames(version: number): Uint8Array {
  const source = `var n = 0 / 0;
var a = [10, 11, 12];
trace("a[NaN] " + a[n] + " a[0.5] " + a[0.5] + " a['NaN'] " + a["NaN"]);
var o = new Object();
o["0"] = "zero";
o["NaN"] = "nan";
trace("o[NaN] " + o[n] + " hasOwnProperty(NaN) " + o.hasOwnProperty(n));
var b = [];
b[n] = 5;
var keys = "";
for (var k in b) { keys += k + ","; }
trace("b[NaN] = 5: b[0] " + b[0] + " length " + b.length + " keys " + keys);
delete b[n];
trace("deleted: length " + b.length + " b[0] " + b[0]);
this["0"] = "this zero";
trace("this[NaN] " + this[n]);`;
  return avm1Swf(version, [], [[as1(source, version)]]);
}

// A Sound's volume and pan in a SWF of `version` set to what is no number:
// undefined, nothing, null, NaN and strings, beside numbers out of range,
// as a game that sets its sounds' volume from a saved setting it never
// saved does every frame.
function avm1SoundVolumes(version: number): Uint8Array {
  const source = `var s = new Sound();
function v(label) { trace(label + " " + s.getVolume()); }
v("fresh");
s.setVolume(50); v("50");
s.setVolume(undefined); v("undefined");
s.setVolume(50); s.setVolume(); v("none");
s.setVolume(50); s.setVolume(null); v("null");
s.setVolume(50); s.setVolume(0 / 0); v("NaN");
s.setVolume(50); s.setVolume("70"); v("string 70");
s.setVolume(50); s.setVolume("x"); v("string x");
s.setVolume(-5); v("-5");
s.setVolume(150); v("150");
s.setVolume(33.7); v("33.7");
s.setVolume(1e10); v("1e10");
s.setPan(40); s.setPan(undefined); trace("pan undefined " + s.getPan());
s.setPan(40); s.setPan(0 / 0); trace("pan NaN " + s.getPan());
var t = new Sound(this);
t.setVolume(60); t.setVolume(undefined); trace("clip undefined " + t.getVolume());
s.setVolume(100); s.setPan(0);`;
  return avm1Swf(version, [], [[as1(source, version)]]);
}

// Clips as AVM1 sees them in a SWF of `version`, avm1/clips.as (docs/avm1.md,
// "Clips and paths"): `a` and `c` of a clip of three frames, which places
// `b` of another, beside an unnamed square and `Beta`; each clip traces its
// frames, which play in Flash's order, the newest clip first.
function avm1Clips(version: number): Uint8Array {
  const source = readFileSync(new URL("../avm1/clips.as", import.meta.url), "utf8");
  const inner = avm1Sprite(2, [
    [w.place({ depth: 1, character: 1 }), as1(`trace("inner " + _target);`, version)],
  ]);
  const mover = avm1Sprite(3, [
    [
      w.frameLabel("one"),
      w.place({ depth: 1, character: 2, name: "b" }),
      as1(`trace("mover 1 " + _target);`, version),
    ],
    [w.frameLabel("Two"), as1(`trace("mover 2 " + _target);`, version)],
    [as1(`trace("mover 3 " + _target); stop();`, version)],
  ]);
  return avm1Swf(
    version,
    [square(1, 0xff0000, 400), inner, mover],
    [
      [
        w.place({ depth: 1, character: 3, name: "a", matrix: { tx: 200, ty: 100 } }),
        w.place({ depth: 2, character: 3, name: "c", matrix: { tx: 600, ty: 100 } }),
        w.place({ depth: 3, character: 1, matrix: { tx: 0, ty: 800 } }),
        w.place({ depth: 4, character: 2, name: "Beta", matrix: { tx: 900, ty: 900 } }),
        as1(source, version),
      ],
      [as1(`trace("root 2");`, version)],
      [as1(`trace("root 3"); stop();`, version)],
    ],
  );
}

// Gotos in a SWF of `version`, avm1/gotos.as and the root's later frames:
// a clip of four labelled frames whose frames 2 to 4 place clips before
// and after their actions, which a goto makes and runs in tag order,
// those of the frames before the target first; the frames a goto enters
// queued and run in Flash's order.
function avm1Gotos(version: number): Uint8Array {
  const source = readFileSync(new URL("../avm1/gotos.as", import.meta.url), "utf8");
  const traced = (frame: number) =>
    as1(`trace("leaf " + _parent._name + "." + _name + " ${frame}");`, version);
  const leaf = avm1Sprite(2, [[traced(1)], [traced(2)]]);
  const place = (depth: number, name: string) => w.place({ depth, character: 2, name });
  const clip = avm1Sprite(3, [
    [w.frameLabel("start"), as1(`trace("clip " + _name + " 1"); stop();`, version)],
    [w.frameLabel("Middle"), place(1, "early"), as1(`trace("clip " + _name + " 2");`, version)],
    [place(2, "before"), as1(`trace("clip " + _name + " 3");`, version), place(3, "after")],
    [as1(`trace("clip " + _name + " 4"); stop();`, version), place(4, "four")],
  ]);
  return avm1Swf(
    version,
    [leaf, clip],
    [
      [
        w.place({ depth: 1, character: 3, name: "a" }),
        w.place({ depth: 2, character: 3, name: "b" }),
        as1(source, version),
        w.place({ depth: 3, character: 3, name: "c" }),
      ],
      [
        as1(
          `trace("root 2 " + a._currentframe + " " + b._currentframe); b.gotoAndStop(4); a.gotoAndStop(1);`,
          version,
        ),
      ],
      [
        as1(
          `trace("root 3 " + a._currentframe); a.gotoAndStop(4); a.prevFrame(); trace(a._currentframe); stop();`,
          version,
        ),
      ],
    ],
  );
}

function avm1FrameLabelAliases(version: number): Uint8Array {
  const clip = avm1Sprite(1, [
    [w.frameLabel("initial"), as1("stop();", version)],
    [w.frameLabel("first"), w.frameLabel("second"), w.frameLabel("repeat")],
    [w.frameLabel("repeat")],
  ]);
  return avm1Swf(
    version,
    [clip],
    [
      [
        w.place({ depth: 1, character: 1, name: "a" }),
        as1(
          `stop();
tellTarget ("a") {
  gotoAndStop("first");
  trace("literal " + _currentframe);
  gotoAndStop(1);
  var label = "second";
  gotoAndStop(label);
  trace("dynamic " + _currentframe);
}
a.gotoAndStop(1);
a.gotoAndStop("FIRST");
trace("method first " + a._currentframe);
a.gotoAndStop(1);
a.gotoAndStop("second");
trace("method second " + a._currentframe);
a.gotoAndStop(1);
a.gotoAndStop("repeat");
trace("repeated " + a._currentframe);`,
          version,
        ),
      ],
    ],
  );
}

// Slash paths in a SWF 4 or 5, avm1/paths.as: variables of clips by
// `/a:x`, GetProperty and SetProperty of slash paths, tellTarget.
function avm1Paths(version: number): Uint8Array {
  const source = readFileSync(new URL("../avm1/paths.as", import.meta.url), "utf8");
  const clip = avm1Sprite(3, [
    [w.place({ depth: 1, character: 4, name: "inner" }), as1(`x = 1;`, version)],
    [as1(`stop();`, version)],
  ]);
  return avm1Swf(
    version,
    [avm1Sprite(4, [[]]), clip],
    [[w.place({ depth: 1, character: 3, name: "a" }), as1(source, version)]],
  );
}

// Functions defined in clips in a SWF of `version`, avm1/scopes.as: their
// targets, `this`, `_parent` and `_root`, called through clips, by name, in
// tellTarget and with, as SWF 5's non-closures and later SWFs' closures.
function avm1Scopes(version: number): Uint8Array {
  const source = readFileSync(new URL("../avm1/scopes.as", import.meta.url), "utf8");
  const inner = avm1Sprite(2, [
    [
      as1(
        `var where = "inner"; function who() { return _target + " " + where + " " + (this == _root ? "root" : this._name); }`,
        version,
      ),
    ],
  ]);
  const clip = avm1Sprite(3, [
    [
      w.place({ depth: 1, character: 2, name: "kid" }),
      as1(
        `var where = "clip"; function f() { trace("f " + _target + " " + where + " " + typeof kid + " " + _parent._target + " " + _root._target + " " + (this == _root ? "root" : this._name)); return kid; } stop();`,
        version,
      ),
    ],
  ]);
  return avm1Swf(
    version,
    [inner, clip],
    [[w.place({ depth: 1, character: 3, name: "a" }), as1(source, version)]],
  );
}

// Clips' properties as they draw (docs/avm1.md, "Clips and paths"): a
// square's clip moved, scaled, turned, faded, hidden and sized by
// SetProperty and SetMember.
function avm1ClipDrawn(): Uint8Array {
  const clip = avm1Sprite(2, [[w.place({ depth: 1, character: 1 })]]);
  const place = (depth: number, name: string, tx: number) =>
    w.place({ depth, character: 2, name, matrix: { tx, ty: 200 } });
  return avm1Swf(
    6,
    [square(1, 0x3366cc, 400), clip],
    [
      [
        place(1, "a", 100),
        place(2, "b", 600),
        place(3, "c", 1100),
        place(4, "d", 1600),
        place(5, "e", 100),
        as1(
          `a._x = 30.5; a._y = 40; a._rotation = 90;
b._xscale = 150; b._yscale = 50; b._alpha = 40;
c._visible = false; d._visible = 0; setProperty("d", 7, 1); setProperty("d", 0, 60); setProperty("d", 1, 30);
e._width = 70; e._height = 12; e._y = 70;`,
          6,
        ),
      ],
      [as1(`stop();`, 6)],
    ],
  );
}

// Filters a SWF 8 script sets on clips of a square (docs/avm1.md, "flash.filters"):
// a blur, a glow, a drop shadow, a bevel, a colour matrix and a gradient glow,
// one cleared again, and the shadow read back and set on another clip.
function avm1Filters(): Uint8Array {
  const clip = avm1Sprite(2, [[w.place({ depth: 1, character: 1 })]]);
  const place = (depth: number, name: string, tx: number, ty: number) =>
    w.place({ depth, character: 2, name, matrix: { tx, ty } });
  return avm1Swf(
    8,
    [square(1, 0x3366cc, 400), clip],
    [
      [
        place(1, "a", 200, 200),
        place(2, "b", 900, 200),
        place(3, "c", 1600, 200),
        place(4, "d", 200, 1000),
        place(5, "e", 900, 1000),
        place(6, "f", 1600, 1000),
        place(7, "g", 200, 1600),
        as1(
          `var F = flash.filters;
a.filters = [new F.BlurFilter(6, 2, 2)];
b.filters = [new F.GlowFilter(0xff3300, 0.8, 8, 8, 2, 1)];
c.filters = [new F.DropShadowFilter(5, 60, 0x000000, 0.6, 4, 4, 1, 1)];
d.filters = [new F.BevelFilter(3, 45, 0xffffff, 1, 0x000000, 1, 3, 3, 1, 1, "inner")];
e.filters = [new F.ColorMatrixFilter([0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0])];
f.filters = [new F.GradientGlowFilter(0, 45, [0xffffff, 0xff0000], [0, 1], [0, 255], 6, 6, 1, 1, "outer")];
g.filters = [new F.BlurFilter()]; g.filters = [];
g.filters = c.filters;
trace(a.filters[0].blurX + " " + g.filters.length + " " + g.filters[0].distance);`,
          8,
        ),
      ],
      [as1(`stop();`, 8)],
    ],
  );
}

/** Clip actions for a place in a SWF of `version`: each record's events and its AS1 source. */
const clipEvents = (version: number, records: [number, string][]) =>
  w.clipActions(
    version,
    records.map(([events, source]) => ({
      events,
      actions: [...script(source, version)(flashAssembler()).end().bytes()],
    })),
  );

// The clip events' bits (format's ClipEvent).
const EVENT = {
  load: 1 << 0,
  enterFrame: 1 << 1,
  unload: 1 << 2,
  mouseDown: 1 << 4,
  data: 1 << 8,
  initialize: 1 << 9,
  construct: 1 << 18,
};

/** Clip actions that trace each event's name, `tag` and the clip's name. */
const tracedEvents = (version: number, tag: string, events: (keyof typeof EVENT)[]) =>
  clipEvents(
    version,
    events.map((e) => [EVENT[e], `trace("${tag} ${e} " + this._name);`]),
  );

// Clip events in a SWF of `version` (docs/avm1.md, "Clip events"): a
// clip's initialize, construct, load, enterFrame and unload, its child's
// first, the events nothing brings (mouseDown, data) never; from SWF 6
// the handlers set as methods, onLoad, onEnterFrame and onUnload, after
// the clip actions; and a clip removed with an unload handler, kept a
// frame at a depth below the timeline's.
function avm1Events(version: number): Uint8Array {
  const handlers = version >= 6;
  const kid = avm1Sprite(2, [
    [w.place({ depth: 1, character: 1 }), as1(`trace("kid frame " + _name);`, version)],
  ]);
  const clip = avm1Sprite(3, [
    [
      w.place({
        depth: 1,
        character: 2,
        name: "kid",
        clipActions: tracedEvents(version, "kid", [
          "initialize",
          "construct",
          "load",
          "enterFrame",
          "unload",
        ]),
      }),
      as1(`trace("clip frame 1 " + _name);`, version),
    ],
    [as1(`trace("clip frame 2 " + _name);`, version)],
  ]);
  return avm1Swf(
    version,
    [square(1, 0x3366cc, 200), kid, clip],
    [
      [
        as1(`trace("root 1");`, version),
        w.place({
          depth: 1,
          character: 3,
          name: "a",
          clipActions: tracedEvents(version, "a", [
            "initialize",
            "construct",
            "load",
            "enterFrame",
            "unload",
            "mouseDown",
            "data",
          ]),
        }),
        as1(
          handlers
            ? `trace("root 1 after " + typeof a.kid);
a.onLoad = function () { trace("a onLoad"); };
a.onEnterFrame = function () { trace("a onEnterFrame " + this._currentframe); };
a.onUnload = function () { trace("a onUnload " + this._name); };
_root.onEnterFrame = function () { trace("root onEnterFrame " + _currentframe); };`
            : `trace("root 1 after " + typeof a.kid);`,
          version,
        ),
      ],
      [
        as1(`trace("root 2");`, version),
        w.place({ depth: 2, character: 3, name: "b" }),
        as1(
          handlers
            ? `b.onUnload = function () { trace("b onUnload " + this._name + " " + typeof this.kid); };`
            : `trace("b " + typeof b);`,
          version,
        ),
      ],
      [
        w.remove(1),
        as1(`trace("root 3 " + typeof a + " " + a._name + " " + typeof a.kid);`, version),
      ],
      [w.remove(2), as1(`trace("root 4 " + typeof a + " " + typeof b);`, version)],
      [as1(`trace("root 5"); delete _root.onEnterFrame; stop();`, version)],
    ],
  );
}

// Clips made with a class Object.registerClass binds to their symbol, in a
// SWF of `version`, avm1/construct.as: by the timeline, by
// duplicateMovieClip, attachMovie and createEmptyMovieClip, with their
// clip events' and constructors' order.
function avm1Construct(version: number): Uint8Array {
  const source = readFileSync(new URL("../avm1/construct.as", import.meta.url), "utf8");
  const show = (what: string) =>
    `trace("${what} " + this._name + " p=" + this.p + " q=" + this.q + " kid=" + typeof this.kid + " hello=" + typeof this.hello + " own=" + this.hasOwnProperty("p"));`;
  const kid = avm1Sprite(3, [[as1(`trace("kid frame 1 " + _parent._name);`, version)]]);
  const clip = avm1Sprite(2, [
    [
      w.place({
        depth: 1,
        character: 3,
        name: "kid",
        clipActions: clipEvents(version, [
          [EVENT.initialize, `trace("kid initialize " + _parent._name);`],
          [EVENT.construct, `trace("kid construct " + _parent._name);`],
          [EVENT.load, `trace("kid load " + _parent._name);`],
        ]),
      }),
      as1(`trace("clip frame 1 " + this._name + " " + this.q);`, version),
    ],
  ]);
  const register = `_global.C = function () { trace("C " + this._name + " p=" + this.p + " kid=" + typeof this.kid); this.q = 1; };
C.prototype = new MovieClip();
C.prototype.hello = function () { return "hi"; };
trace("registered " + Object.registerClass("clip", C));`;
  return avm1Swf(
    version,
    [kid, clip, w.exportAssets([[2, "clip"]])],
    [
      [
        w.place({
          depth: 1,
          character: 2,
          name: "a",
          clipActions: clipEvents(version, [
            [EVENT.initialize, show("initialize")],
            [EVENT.construct, show("construct")],
            [EVENT.load, show("load")],
          ]),
        }),
        w.doInitAction(2, [...script(register, version)(flashAssembler()).end().bytes()]),
        as1(source, version),
      ],
      [as1(`trace("root 2"); stop();`, version)],
    ],
  );
}

// Clips a script makes and removes by depth in a SWF of `version`,
// avm1/depths.as, and from SWF 7 avm1/depths7.as.
function avm1Depths(version: number): Uint8Array {
  const read = (name: string) =>
    readFileSync(new URL(`../avm1/${name}.as`, import.meta.url), "utf8");
  const clip = avm1Sprite(2, [[w.place({ depth: 1, character: 1 })]]);
  return avm1Swf(
    version,
    [square(1, 0x3366cc, 200), clip, w.exportAssets([[2, "clip"]])],
    [
      [
        w.place({ depth: 1, character: 2, name: "a" }),
        as1(read("depths"), version),
        ...(version >= 7 ? [as1(read("depths7"), version)] : []),
      ],
      [as1(`trace("root 2 " + typeof _root.y + " " + typeof _root.c1); stop();`, version)],
    ],
  );
}

// A shape test inside a clip whose timeline masks part of it: what the mask
// covers is hit, what it leaves out is not, nothing where its frame is
// empty, as a clip hides a part by playing its mask to nothing.
function avm1HitTestUnderMask(version: number): Uint8Array {
  const half = w.shape({
    id: 5,
    bounds: [0, 500, 0, 1000],
    fills: [0x000000],
    paths: [
      {
        fill1: 1,
        commands: [
          { move: [0, 0] },
          { line: [500, 0] },
          { line: [500, 1000] },
          { line: [0, 1000] },
          { line: [0, 0] },
        ],
      },
    ],
  });
  const mask = avm1Sprite(4, [
    [w.place({ depth: 1, character: 1 }), as1("stop();", version)],
    [w.remove(1)],
    [w.place({ depth: 1, character: 5 })],
  ]);
  const block = avm1Sprite(3, [
    [
      w.place({ depth: 1, character: 4, name: "m", clipDepth: 5 }),
      w.place({ depth: 3, character: 2 }),
    ],
  ]);
  return avm1Swf(
    version,
    [square(1, 0x000000), square(2, 0x3366cc), half, mask, block],
    [
      [
        w.place({ depth: 1, character: 3, name: "b", matrix: { tx: 200, ty: 200 } }),
        as1(
          `function probe(label) {
  trace(label + " left " + _root.hitTest(20, 35, true) + " " + b.hitTest(20, 35, true) +
    " right " + _root.hitTest(50, 35, true) + " " + b.hitTest(50, 35, true) +
    " bounds " + b.hitTest(50, 35, false));
}
probe("covered");
b.m.gotoAndStop(2);
probe("empty");
b.m.gotoAndStop(3);
probe("half");
stop();`,
          version,
        ),
      ],
    ],
  );
}

// A rewind over clips that swapped depths, as a fighting game's lesson
// loop has them: the template fighter swaps under the hero, a copy of it
// at a script's depth swaps under the hero in turn, and beaten, it is
// removed (which leaves a clip at the timeline's depths) and the timeline
// goes back to the frame after the one that placed both. The frames
// replayed place the hero at its depth, where the template now is: whether
// the template stays there or a new hero is made beside the one swapped
// away.
function avm1RewindSwapped(version: number, heroSwaps: boolean): Uint8Array {
  const hero = avm1Sprite(3, [[w.place({ depth: 1, character: 1 })]]);
  const fighter = avm1Sprite(4, [[w.place({ depth: 1, character: 2 })], [], []]);
  const describe = `_root.describe = function (label) {
  var clips = [];
  for (var k in _root) {
    if (typeof _root[k] == "movieclip" && k != "hero" && k != "template") { clips.push(_root.describe1(_root[k])); }
  }
  clips.sort();
  trace(label + ": em=" + _root.describe1(_root.em) + " hero=" + _root.describe1(_root.hero) +
    " template=" + _root.describe1(_root.template) + " em is hero=" + (_root.em == _root.hero) +
    " clips=" + clips.join(" "));
};
_root.describe1 = function (c) {
  return c == undefined ? "none" : c._name + "@" + c.getDepth() + "/" + (c.tag == undefined ? "new" : c.tag) + "/x" + c._x;
};`;
  return avm1Swf(
    version,
    [square(1, 0x00cccc), square(2, 0x000000, 600), hero, fighter],
    [
      [
        w.place({ depth: 29, character: 3, name: "em", ratio: 1, matrix: { tx: 200, ty: 400 } }),
        w.place({ depth: 45, character: 4, name: "m", ratio: 1, matrix: { tx: 1200, ty: 400 } }),
        as1(
          `${describe} em.tag = "hero"; m.tag = "template"; _root.hero = em; _root.template = m; _root.describe("placed"); ${heroSwaps ? "_root.em.swapDepths(m)" : "m.swapDepths(_root.em)"}; _root.describe("template");`,
          version,
        ),
      ],
      [as1(`_root.describe("lesson"); if (_root.done) { stop(); }`, version)],
      [
        as1(
          `duplicateMovieClip("m", "m1", 16385);
setProperty("m1", _x, 2000);
m1.tag = "copy";
m1.swapDepths(_root.em);
_root.describe("swapped");`,
          version,
        ),
      ],
      [as1(`removeMovieClip(m1); _root.describe("beaten");`, version)],
      [as1(`_root.done = true; gotoAndStop(2); _root.describe("back");`, version)],
    ],
  );
}

// #initclip, the root's DoInitAction blocks (docs/avm1.md, "The frame"):
// a frame's run as the root enters it, before its places and its actions,
// in tag order, a sprite's once; a sprite attached before its own runs.
function avm1Initclip(): Uint8Array {
  const version = 6;
  const init = (sprite: number, source: string) =>
    w.doInitAction(sprite, [...script(source, version)(flashAssembler()).end().bytes()]);
  const sprite = (id: number) =>
    avm1Sprite(id, [[as1(`trace("sprite ${id} " + _name);`, version)]]);
  return avm1Swf(
    version,
    [
      sprite(2),
      sprite(3),
      sprite(4),
      w.exportAssets([
        [2, "two"],
        [3, "three"],
        [4, "four"],
      ]),
    ],
    [
      [
        as1(`trace("root 1"); attachMovie("three", "early", 1);`, version),
        w.place({ depth: 2, character: 2, name: "placed" }),
        init(2, `trace("init two");`),
        init(4, `trace("init four");`),
      ],
      [
        init(3, `trace("init three");`),
        as1(`trace("root 2");`, version),
        init(2, `trace("init two again");`),
        w.place({ depth: 3, character: 3, name: "late" }),
      ],
      [as1(`trace("root 3"); attachMovie("four", "four", 4); stop();`, version)],
    ],
  );
}

// setTimeout and setInterval in a SWF of `version` at 2 frames a second,
// avm1/timers.as: what they fire between frames, by Flash's clock and the
// tests' frame clock alike.
function avm1Timers(version: number): Uint8Array {
  const source = readFileSync(new URL("../avm1/timers.as", import.meta.url), "utf8");
  return w.swf({
    version,
    width: 40,
    height: 40,
    frameRate: 2,
    frameCount: 7,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      as1(source, version),
      w.showFrame(),
      as1(`trace("root 2");`, version),
      w.showFrame(),
      as1(`trace("root 3");`, version),
      w.showFrame(),
      as1(`trace("root 4");`, version),
      w.showFrame(),
      as1(`trace("root 5"); delete _root.onEnterFrame;`, version),
      w.showFrame(),
      w.showFrame(),
      as1(`trace("root 7 " + later.join(", ")); stop();`, version),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Past the recursion limit, a ScriptLimits of 40 here, Flash disables the
// movie's actions, the rest of the frame's and every later frame's, which
// no catch or finally runs, and its timeline plays on: frame 2 places a
// square, which frame 3 shows.
function avm1Recursion(): Uint8Array {
  return w.swf({
    version: 6,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.backgroundColor(0xffffff),
      w.tag(tags.ScriptLimits, Uint8Array.from([40, 0, 15, 0])),
      square(1, 0xff0000, 400),
      block(
        setVar("depth", lit(0)),
        defineFn(
          "deep",
          [],
          setVar("depth", op("Increment", getVar("depth"))),
          ifThen(op("Greater", getVar("depth"), lit(35)), traceOf(getVar("depth"))),
          drop(callFunction("deep")),
          note("unwound"),
        ),
        tryDo("e", [drop(callFunction("deep"))], traceCaught("e"), [note("not finally")]),
        note("after"),
      ),
      block(note("the next block")),
      w.showFrame(),
      w.place({ depth: 1, character: 1, matrix: { tx: 100, ty: 100 } }),
      block(note("frame 2")),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// A ScriptLimits takes effect as its frame comes, before the frame's
// actions, and of two in a frame the later: frame 1 recurses 100 deep
// under Flash's default limit, frame 2 sets 80 then 40, under which 30
// deep runs and 60 disables the actions, frame 3's too.
function avm1ScriptLimits(): Uint8Array {
  const limits = (depth: number) => w.tag(tags.ScriptLimits, Uint8Array.from([depth, 0, 15, 0]));
  const recurse = (n: number) => [
    setVar("depth", lit(0)),
    drop(callFunction("deep", lit(n))),
    traceOf(op("Add2", lit("reached "), getVar("depth"))),
  ];
  return w.swf({
    version: 6,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.backgroundColor(0xffffff),
      block(
        defineFn(
          "deep",
          ["n"],
          setVar("depth", op("Increment", getVar("depth"))),
          ifThen(
            op("Less2", getVar("depth"), getVar("n")),
            drop(callFunction("deep", getVar("n"))),
          ),
        ),
        ...recurse(100),
      ),
      w.showFrame(),
      block(note("frame 2"), ...recurse(30)),
      limits(80),
      limits(40),
      block(...recurse(60), note("unreached")),
      w.showFrame(),
      block(note("frame 3")),
      w.showFrame(),
      w.end(),
    ],
  });
}

const goTo =
  (name: string): Avm1Statement =>
  (a) =>
    a.jump(name);

const throwOf =
  (e: Avm1Expr): Avm1Statement =>
  (a) =>
    e(a).op("Throw");

/** `with (o) { statements }`. */
const withDo =
  (o: Avm1Expr, ...statements: Avm1Statement[]): Avm1Statement =>
  (a) => {
    const end = label();
    return statements.reduce((b, s) => s(b), o(a).with(end)).label(end);
  };

/**
 * `try { body } catch (into) { caught } finally { always }`, as compilers
 * write it: the try body and the catch go on at the finally. A null catch
 * or finally is none; `runOff` leaves out the try body's jump past the
 * catch, so that it runs off into the catch's bytes.
 */
const tryDo =
  (
    into: string | number,
    body: Avm1Statement[],
    caught: Avm1Statement[] | null,
    always: Avm1Statement[] | null,
    runOff = false,
  ): Avm1Statement =>
  (a) => {
    const catchAt = label();
    const finallyAt = label();
    const end = label();
    const flags =
      (caught ? TryFlag.catch : 0) |
      (always ? TryFlag.finally : 0) |
      (typeof into === "number" ? TryFlag.catchInRegister : 0);
    a.try(typeof into === "number" ? register(into) : into, catchAt, finallyAt, end, flags);
    body.reduce((b, s) => s(b), a);
    if (caught && !runOff) {
      a.jump(finallyAt);
    }

    a.label(catchAt);
    (caught ?? []).reduce((b, s) => s(b), a);
    a.label(finallyAt);
    (always ?? []).reduce((b, s) => s(b), a);
    return a.label(end);
  };

const concat = (...parts: Avm1Expr[]): Avm1Expr => parts.reduce((x, y) => op("Add2", x, y));

/** `catch (e) { trace("caught " + e) }`. */
const traceCaught = (into: string) => [traceOf(concat(lit("caught "), getVar(into)))];

/** `depth` Withs one in another, each of an object whose `v` is its depth, `v` traced in the last. */
const withNest = (depth: number): Avm1Statement => {
  let s: Avm1Statement = traceOf(concat(lit(`${depth} deep: `), getVar("v")));
  for (let k = depth; k >= 1; k--) {
    s = withDo(initObject(["v", lit(k)]), s, ...(k === depth - 1 ? [note(`left ${depth}`)] : []));
  }

  return s;
};

// What With, Try and Throw do in a SWF of `version`, as adl traces it
// (docs/avm1.md, "With and Try"): a With's object on the scope chain while
// control stays in its body, its body skipped for undefined, null, or a
// chain already 15 deep; a jump out of a body, back before it or into it;
// Try's catch, its variable the catch body's own or a register, the
// finally after a throw, a Return or neither, and a throw again as control
// leaves it; the operand stack a throw cuts back; throws through calls,
// getters, watchers and conversions; Error; and a throw nothing catches,
// which ends its block and nothing else.
function avm1Control(version: number): Uint8Array {
  const o = initObject(["a", lit("oa")], ["x", lit("ox")]);
  const out = label();
  const back = label();
  const into = label();
  const tryBack = label();
  const tryInto = label();
  const finallyOut = label();
  const finallyOut2 = label();
  const returnOut = label();
  const pastOut = label();
  const pastEnd = label();
  const pastBack = label();
  const pastDone = label();
  const i = getVar("i");
  return w.swf({
    version,
    width: 40,
    height: 40,
    frameRate: 24,
    frameCount: 3,
    tags: [
      ...(version >= 8 ? [w.fileAttributes(false)] : []),
      w.backgroundColor(0xffffff),
      block(
        note("-- with"),
        setVar("o", o),
        setVar("a", lit("root a")),
        withDo(
          getVar("o"),
          traceOf(getVar("a")),
          setVar("a", lit("set a")),
          setVar("nb", lit("nb")),
          local("dl", lit("dl")),
          local("x", lit("set x")),
        ),
        traceOf(member(getVar("o"), "a")),
        traceOf(member(getVar("o"), "nb")),
        traceOf(getVar("nb")),
        traceOf(member(getVar("o"), "dl")),
        traceOf(getVar("dl")),
        traceOf(member(getVar("o"), "x")),
        traceOf(getVar("a")),
        withDo(lit(undefined), note("not with undefined")),
        withDo(lit(null), note("not with null")),
        withDo(lit(5), traceOf(callFunction("toString")), traceOf(getVar("length"))),
        withDo(lit("abc"), traceOf(getVar("length"))),
        withDo(lit(true), traceOf(callFunction("toString"))),
        note("-- with: jumps"),
        setVar("i", lit(0)),
        withDo(getVar("o"), traceOf(getVar("a")), goTo(out), note("not after the jump")),
        at(out),
        traceOf(getVar("x")),
        at(back),
        traceOf(getVar("x")),
        setVar("i", op("Increment", i)),
        withDo(
          getVar("o"),
          traceOf(getVar("x")),
          code((a) => a.push("i").op("GetVariable").push(2).op("Less2").if(back)),
          note("the body's end"),
        ),
        goTo(into),
        withDo(getVar("o"), note("not run"), at(into), traceOf(getVar("x"))),
        note("-- with: depth"),
        withNest(13),
        withNest(14),
        note("in a function"),
        defineFn("deeper", [], withNest(12), withNest(13)),
        drop(callFunction("deeper")),
        // A function defined in 5 Withs, which from SWF 6 it closes over.
        [1, 2, 3, 4, 5].reduceRight<Avm1Statement>(
          (inner, k) => withDo(initObject(["v", lit(`closed over ${k}`)]), inner),
          defineFn("closure", [], withNest(7), withNest(8), traceOf(getVar("v"))),
        ),
        drop(callFunction("closure")),
        note("-- with: one action late"),
        withDo(
          getVar("o"),
          code((a) => a.push("a")),
        ),
        code((a) => a.op("GetVariable").trace()),
        withDo(
          getVar("o"),
          code((a) => a.push("a")),
        ),
        traceOf(getVar("a")),
        // A function defined by the first action past a body closes over its scope.
        withDo(getVar("o")),
        defineFn("late", [], traceOf(getVar("x"))),
        drop(callFunction("late")),
        withNest(13),
        defineFn("full", [], traceOf(getVar("v")), withNest(1)),
        drop(callFunction("full")),
        note("-- with: where control goes past a body"),
        // Only the first action past a body runs in its scope: one a jump reaches does not.
        withDo(
          getVar("o"),
          code((a) => a.push("x")),
          goTo(pastOut),
        ),
        note("not run"),
        at(pastOut),
        code((a) => a.op("GetVariable").trace()),
        withDo(
          getVar("o"),
          code((a) => a.push("x")),
          goTo(pastEnd),
        ),
        at(pastEnd),
        code((a) => a.op("GetVariable").trace()),
        // A jump back before the With finds no scope.
        setVar("i", lit(0)),
        code((a) => a.push("x")),
        at(pastBack),
        code((a) => a.op("GetVariable").trace()),
        setVar("i", op("Increment", i)),
        code((a) => a.push("i").op("GetVariable").push(2).op("Less2").op("Not").if(pastDone)),
        withDo(
          getVar("o"),
          code((a) => a.push("x")),
          goTo(pastBack),
        ),
        at(pastDone),
        // A With as the first action past a body keeps that scope under its own, and both come
        // off together; a jump from there back into the body keeps it too.
        setVar("p", initObject(["q", lit("pq")])),
        withDo(
          getVar("o"),
          code((a) => a.push("p").op("GetVariable")),
        ),
        withDo(
          code((a) => a),
          traceOf(getVar("x")),
          code((a) => a.push("x")),
        ),
        code((a) => a.op("GetVariable").trace()),
        traceOf(getVar("x")),
        setVar("i", lit(0)),
        code((a) => {
          const body = label();
          const end = label();
          a.push("o").op("GetVariable").with(end).label(body);
          a.push("x").op("GetVariable").trace();
          a.push("i", "i").op("GetVariable").op("Increment").op("SetVariable");
          return a.push("i").op("GetVariable").push(2).op("Less2").label(end).if(body);
        }),
        traceOf(getVar("x")),
        // A throw as the first action past a body keeps its scope over the catch body; a finally
        // reached by a throw or a Return keeps a scope only for its first action, and only where
        // that is the first action past the scope's body.
        tryDo(
          "e",
          [
            withDo(
              getVar("o"),
              code((a) => a.push("t")),
            ),
            code((a) => a.op("Throw")),
          ],
          [traceOf(getVar("x"))],
          null,
        ),
        tryDo(
          "e",
          [
            code((a) => a.push("x")),
            tryDo("i", [withDo(getVar("o"), throwOf(lit(1)))], null, [
              code((a) => a.op("GetVariable").trace()),
              traceOf(getVar("x")),
            ]),
          ],
          [],
          null,
        ),
        tryDo(
          "e",
          [
            code((a) => a.push("x")),
            tryDo("i", [withDo(getVar("o"), throwOf(lit(1))), note("not run")], null, [
              code((a) => a.op("GetVariable").trace()),
            ]),
          ],
          [],
          null,
        ),
        defineFn(
          "pastReturn",
          [],
          tryDo("e", [withDo(getVar("o"), ret(lit("x")))], null, [
            code((a) => a.op("GetVariable").trace()),
            traceOf(getVar("x")),
            code((a) => a.push("returned")),
          ]),
        ),
        traceOf(callFunction("pastReturn")),
        note("-- with: functions"),
        defineFn("g", [], withDo(getVar("o"), ret(getVar("x"))), note("not after return")),
        traceOf(callFunction("g")),
        defineFn(
          "h",
          [],
          withDo(getVar("o"), local("loc", lit("local")), setVar("sv", lit("set"))),
          traceOf(getVar("loc")),
        ),
        drop(callFunction("h")),
        traceOf(op("TypeOf", getVar("loc"))),
        traceOf(getVar("sv")),
        tryDo(
          "e",
          [withDo(getVar("o"), throwOf(getVar("a")))],
          [traceOf(getVar("e")), traceOf(getVar("x"))],
          null,
        ),
      ),
      block(
        note("-- try"),
        tryDo(
          "e",
          [note("try"), throwOf(lit("x")), note("not after the throw")],
          traceCaught("e"),
          [note("finally")],
        ),
        tryDo(
          "e",
          [note("runs off")],
          [note("the catch's bytes"), traceOf(getVar("e"))],
          [note("finally")],
          true,
        ),
        tryDo("e", [throwOf(lit(3))], [traceOf(op("TypeOf", getVar("e")))], null),
        tryDo(
          "e",
          [throwOf(initObject(["m", lit("an object")]))],
          [traceOf(member(getVar("e"), "m"))],
          null,
        ),
        tryDo("e", [throwOf(lit(undefined))], [traceOf(op("TypeOf", getVar("e")))], null),
        tryDo("e", [code((a) => a.op("Throw"))], [traceOf(op("TypeOf", getVar("e")))], null),
        note("-- try: finally"),
        tryDo(
          "o1",
          [tryDo("i1", [throwOf(lit("A"))], null, [note("inner finally")])],
          traceCaught("o1"),
          null,
        ),
        tryDo(
          "o2",
          [
            tryDo(
              "i2",
              [throwOf(lit("B"))],
              [traceOf(getVar("i2")), throwOf(lit("C"))],
              [note("inner finally")],
            ),
            note("not after"),
          ],
          traceCaught("o2"),
          null,
        ),
        tryDo(
          "o3",
          [tryDo("i3", [throwOf(lit("D"))], [throwOf(lit("E"))], null)],
          traceCaught("o3"),
          null,
        ),
        tryDo(
          "o4",
          [
            tryDo("i4", [throwOf(lit("F"))], null, [note("inner finally"), goTo(finallyOut)]),
            at(finallyOut),
            note("not after"),
          ],
          traceCaught("o4"),
          null,
        ),
        tryDo(
          "o5",
          [
            tryDo("i5", [note("no throw")], null, [note("inner finally"), goTo(finallyOut2)]),
            at(finallyOut2),
            note("after the jump"),
          ],
          traceCaught("o5"),
          null,
          true,
        ),
        note("-- try: return"),
        defineFn(
          "r1",
          [],
          tryDo("e", [ret(lit("from try"))], null, [note("finally")]),
          note("not after"),
        ),
        traceOf(callFunction("r1")),
        defineFn(
          "r2",
          [],
          tryDo("e", [throwOf(lit("x"))], [ret(lit("from catch"))], [note("finally")]),
        ),
        traceOf(callFunction("r2")),
        defineFn("r3", [], tryDo("e", [throwOf(lit("x"))], null, [ret(lit("from finally"))])),
        traceOf(callFunction("r3")),
        defineFn("r4", [], tryDo("e", [ret(lit("from try"))], null, [ret(lit("from finally"))])),
        traceOf(callFunction("r4")),
        defineFn(
          "r5",
          [],
          tryDo("e", [ret(lit("from try"))], null, [note("finally"), goTo(returnOut)]),
          at(returnOut),
          note("not after the jump"),
        ),
        traceOf(callFunction("r5")),
        defineFn(
          "r6",
          [],
          tryDo(
            "o",
            [tryDo("e", [ret(lit("inner"))], null, [note("inner finally")]), note("not after")],
            null,
            [note("outer finally")],
          ),
        ),
        traceOf(callFunction("r6")),
        defineFn(
          "r7",
          [],
          tryDo("e", [throwOf(lit("x"))], [ret(lit("from catch"))], [throwOf(lit("from finally"))]),
        ),
        tryDo("e", [traceOf(callFunction("r7"))], traceCaught("e"), null),
        // A Return cuts the stack back to the Try's height, its value left on top, for the finally.
        defineFn(
          "r8",
          [],
          code((a) => a.push("f0")),
          tryDo("e", [code((a) => a.push("j1", "j2", "from try").op("Return"))], null, [
            note("finally"),
          ]),
        ),
        code((a) => a.push("c1")),
        traceOf(callFunction("r8")),
        code((a) => a.trace().trace()),
      ),
      block(
        note("-- try: catch"),
        setVar("e", lit("outer")),
        tryDo(
          "e",
          [throwOf(lit("thrown"))],
          [
            traceOf(getVar("e")),
            setVar("e", lit("set in the catch")),
            local("cl", lit("local in the catch")),
            defineFn("cf", [], traceOf(getVar("e"))),
          ],
          null,
        ),
        traceOf(getVar("e")),
        traceOf(getVar("cl")),
        drop(callFunction("cf")),
        tryDo("x1", [throwOf(lit("x1"))], [], null),
        traceOf(op("TypeOf", getVar("x1"))),
        defineFn(
          "f",
          [],
          local("e", lit("local e")),
          tryDo("e", [throwOf(lit("in f"))], [traceOf(getVar("e"))], null),
          traceOf(getVar("e")),
        ),
        drop(callFunction("f")),
        tryDo("e", [throwOf(lit("x"))], [withNest(12), withNest(13)], null),
        setVar("pp", initObject()),
        tryDo("pp.q", [throwOf(lit("path"))], [traceOf(getVar("pp.q"))], null),
        traceOf(member(getVar("pp"), "q")),
        withDo(
          getVar("o"),
          tryDo("e", [throwOf(lit("in a with"))], [traceOf(getVar("e"))], null),
          traceOf(getVar("e")),
        ),
        // A throw in a With body keeps the With's object over the catch body, an action past it,
        // and an outer catch's body where the catch throws again.
        tryDo("e", [withDo(getVar("o"), throwOf(lit("x")))], [code((a) => a.push("x"))], null),
        code((a) => a.op("GetVariable").trace()),
        traceOf(getVar("x")),
        tryDo(
          "e",
          [tryDo("i", [withDo(getVar("o"), throwOf(lit("x")))], [throwOf(lit("y"))], null)],
          [traceOf(getVar("x")), traceOf(getVar("e")), traceOf(getVar("i"))],
          [traceOf(getVar("x"))],
        ),
        tryDo(1, [throwOf(lit("r1"))], [traceOf(reg(1))], null),
        traceOf(reg(1)),
        tryDo(7, [throwOf(lit("r7"))], [traceOf(reg(7))], null),
        defineFn2(
          "f2",
          4,
          0,
          [],
          tryDo(2, [throwOf(lit("local r2"))], [traceOf(reg(2))], null),
          traceOf(reg(2)),
          tryDo(5, [throwOf(lit("r5"))], [traceOf(reg(5))], null),
          tryDo(0, [throwOf(lit("r0"))], [traceOf(reg(0))], null),
        ),
        drop(callFunction("f2")),
        traceOf(reg(2)),
        note("-- try: the stack"),
        code((a) => a.push("below")),
        tryDo(
          "e",
          [code((a) => a.push("t1", "t2")), throwOf(lit("x"))],
          [code((a) => a.op("PushDuplicate").trace())],
          null,
        ),
        code((a) => a.trace().trace()),
        code((a) => a.push(1, 2, 3)),
        tryDo(
          "e",
          [code((a) => a.pop().pop()), throwOf(lit("x"))],
          [code((a) => a.op("PushDuplicate").trace())],
          null,
        ),
        code((a) => a.trace().trace()),
        defineFn(
          "pusher",
          [],
          code((a) => a.push("f1", "f2")),
          throwOf(lit("from pusher")),
        ),
        code((a) => a.push("under")),
        tryDo(
          "e",
          [drop(callFunction("pusher"))],
          [code((a) => a.op("PushDuplicate").trace())],
          null,
        ),
        code((a) => a.trace().trace()),
        code((a) => a.push("s1")),
        tryDo(
          "o",
          [
            code((a) => a.push("s2")),
            tryDo("i", [code((a) => a.push("s3")), throwOf(lit("y"))], null, [
              code((a) => a.op("PushDuplicate").trace()),
            ]),
          ],
          [code((a) => a.op("PushDuplicate").trace())],
          null,
        ),
        code((a) => a.trace().trace()),
      ),
      block(
        note("-- try: through calls"),
        defineFn("thrower", ["x"], throwOf(getVar("x"))),
        defineFn("mid", [], drop(callFunction("thrower", lit("deep"))), note("not after")),
        tryDo("e", [drop(callFunction("mid"))], traceCaught("e"), null),
        setVar("p", initObject()),
        drop(
          callMethod(
            getVar("p"),
            "addProperty",
            lit("got"),
            fnExpr([], throwOf(lit("getter"))),
            lit(null),
          ),
        ),
        tryDo("e", [traceOf(member(getVar("p"), "got"))], traceCaught("e"), null),
        drop(
          callMethod(
            getVar("p"),
            "addProperty",
            lit("put"),
            fnExpr([], ret(lit("got"))),
            fnExpr(["v"], throwOf(lit("setter"))),
          ),
        ),
        tryDo("e", [setMember(getVar("p"), "put", lit(1))], traceCaught("e"), null),
        traceOf(member(getVar("p"), "put")),
        setVar("ts", initObject()),
        setMember(getVar("ts"), "toString", fnExpr([], note("toString"), throwOf(lit("toString")))),
        tryDo("e", [traceOf(getVar("ts"))], traceCaught("e"), null),
        tryDo("e", [traceOf(concat(lit("in Add2 "), getVar("ts")))], traceCaught("e"), null),
        setVar("fn", fnExpr([])),
        setMember(getVar("fn"), "toString", fnExpr([], throwOf(lit("a function's toString")))),
        tryDo("e", [traceOf(getVar("fn"))], traceCaught("e"), null),
        setVar("ts2", initObject()),
        setMember(getVar("ts2"), "toString", fnExpr([], note("not the second toString"))),
        tryDo(
          "e",
          [traceOf(callMethod(initArray(getVar("ts"), getVar("ts2")), "join"))],
          traceCaught("e"),
          null,
        ),
        setMember(getVar("ts"), "valueOf", fnExpr([], throwOf(lit("valueOf")))),
        tryDo("e", [traceOf(op("Add2", getVar("ts"), lit(1)))], traceCaught("e"), null),
        tryDo(
          "e",
          [traceOf(callMethod(getVar("thrower"), "call", lit(null), lit("by call")))],
          traceCaught("e"),
          null,
        ),
        tryDo(
          "e",
          [traceOf(callMethod(getVar("thrower"), "apply", lit(null), initArray(lit("by apply"))))],
          traceCaught("e"),
          null,
        ),
        setVar("wt", initObject(["k", lit(1)])),
        drop(callMethod(getVar("wt"), "watch", lit("k"), fnExpr([], throwOf(lit("watcher"))))),
        tryDo("e", [setMember(getVar("wt"), "k", lit(2))], traceCaught("e"), null),
        traceOf(member(getVar("wt"), "k")),
        setVar("rs", initObject()),
        setMember(getVar("rs"), "__resolve", fnExpr([], throwOf(lit("__resolve")))),
        tryDo("e", [traceOf(member(getVar("rs"), "zz"))], traceCaught("e"), null),
        defineFn("Thrower", [], throwOf(lit("a constructor"))),
        tryDo("e", [traceOf(newObject("Thrower"))], traceCaught("e"), null),
        tryDo(
          "e",
          [setVar("q", callFunction("thrower", lit("an argument")))],
          traceCaught("e"),
          null,
        ),
        traceOf(op("TypeOf", getVar("q"))),
      ),
      block(
        note("-- Error"),
        traceOf(op("TypeOf", getVar("Error"))),
        keysOf(proto("Error")),
        keysOf(getVar("Error")),
        traceOf(member(proto("Error"), "message")),
        traceOf(member(proto("Error"), "name")),
        traceOf(op("Equals2", member(proto("Error"), "__proto__"), OBJECT_PROTO)),
        setVar("err", newObject("Error", lit("a message"))),
        traceOf(getVar("err")),
        traceOf(member(getVar("err"), "message")),
        traceOf(member(getVar("err"), "name")),
        traceOf(callMethod(getVar("err"), "toString")),
        keysOf(getVar("err")),
        traceOf(callMethod(getVar("err"), "hasOwnProperty", lit("message"))),
        traceOf(callMethod(getVar("err"), "hasOwnProperty", lit("name"))),
        traceOf(op("Equals2", member(getVar("err"), "__constructor__"), getVar("Error"))),
        traceOf(newObject("Error")),
        traceOf(callMethod(newObject("Error"), "hasOwnProperty", lit("message"))),
        traceOf(callMethod(newObject("Error", lit(undefined)), "hasOwnProperty", lit("message"))),
        traceOf(newObject("Error", lit(null))),
        traceOf(op("TypeOf", member(newObject("Error", lit(5)), "message"))),
        setMember(getVar("err"), "name", initObject()),
        traceOf(member(getVar("err"), "name")),
        traceOf(callFunction("Error", lit("called"))),
        traceOf(
          callMethod(
            member(proto("Error"), "toString"),
            "call",
            initObject(["message", lit("borrowed")]),
          ),
        ),
        traceOf(callMethod(member(proto("Error"), "toString"), "call", lit(5))),
        traceOf(concat(lit("in Add2: "), getVar("err"))),
        setVar("Sub", fnExpr([])),
        setMember(getVar("Sub"), "prototype", newObject("Error")),
        setMember(proto("Sub"), "name", lit("SubError")),
        traceOf(member(newObject("Sub", lit("not taken")), "name")),
        tryDo(
          "e",
          [throwOf(newObject("Error", lit("thrown")))],
          [traceOf(getVar("e")), traceOf(member(getVar("e"), "message"))],
          null,
        ),
      ),
      block(
        note("-- try: jumps"),
        setVar("i", lit(0)),
        at(tryBack),
        setVar("i", op("Increment", i)),
        ifThen(op("Equals2", i, lit(2)), note("thrown with no handler"), throwOf(lit("back"))),
        tryDo("e", [note("try"), goTo(tryBack)], traceCaught("e"), null),
        note("not after the try"),
      ),
      block(
        goTo(tryInto),
        tryDo(
          "e",
          [note("not run"), at(tryInto), note("into the try body"), throwOf(lit("in"))],
          traceCaught("e"),
          null,
        ),
        note("not after the throw"),
      ),
      block(
        note("-- uncaught"),
        code((a) => a.push("left")),
        throwOf(lit("U")),
        note("not after the throw"),
      ),
      block(
        note("the next block"),
        code((a) => a.trace().trace()),
      ),
      w.showFrame(),
      block(
        note("-- frame 2"),
        defineFn(
          "uncaught",
          [],
          code((a) => a.push("pushed")),
          throwOf(lit("U")),
          note("not after the throw"),
        ),
        code((a) => a.push("under")),
        drop(callFunction("uncaught")),
        note("not after the call"),
      ),
      block(
        note("the next block"),
        code((a) => a.trace().trace()),
      ),
      w.showFrame(),
      block(note("-- frame 3"), (a) => a.stop()),
      w.showFrame(),
      w.end(),
    ],
  });
}

// AVM1 SWFs an AS3 one loads (scripts/Avm1Movie.as.template): one of
// version 8 whose FileAttributes leaves out ActionScript 3, three frames
// that move a square and add another, and one of version 6 without
// FileAttributes, a green square. The first's frame 1 has a DoAction,
// `x = "1"`, which changes no pixels.
function avm1Movie(compile: Compile): Uint8Array {
  const inner = w.swf({
    version: 8,
    width: 100,
    height: 50,
    frameRate: 12,
    frameCount: 3,
    tags: [
      w.fileAttributes(false),
      w.backgroundColor(0xffffff),
      square(1, 0xff0000),
      square(2, 0x0000ff, 400),
      w.place({ depth: 1, character: 1, matrix: { tx: 100, ty: 100 } }),
      // Push "x", push "1", SetVariable, End.
      w.tag(12, Uint8Array.from([0x96, 3, 0, 0, 0x78, 0, 0x96, 3, 0, 0, 0x31, 0, 0x1d, 0])),
      w.showFrame(),
      w.place({ depth: 1, move: true, matrix: { tx: 500, ty: 100 } }),
      w.place({ depth: 2, character: 2, matrix: { tx: 1400, ty: 400 } }),
      w.showFrame(),
      w.remove(2),
      w.showFrame(),
      w.end(),
    ],
  });
  const bare = w.swf({
    version: 6,
    width: 60,
    height: 40,
    frameRate: 30,
    frameCount: 1,
    tags: [
      w.backgroundColor(0xffffff),
      square(1, 0x00aa00, 600),
      w.place({ depth: 1, character: 1, matrix: { tx: 200, ty: 200 } }),
      w.showFrame(),
      w.end(),
    ],
  });
  const template = readFileSync(
    new URL("../scripts/Avm1Movie.as.template", import.meta.url),
    "utf8",
  );
  const abc = compile(
    "Avm1Movie",
    template
      .replaceAll("@@INNER@@", Buffer.from(inner).toString("base64"))
      .replaceAll("@@BARE@@", Buffer.from(bare).toString("base64")),
  );
  return w.swf({
    width: 200,
    height: 100,
    frameRate: 24,
    frameCount: 3,
    tags: [
      w.fileAttributes(true),
      w.backgroundColor(0xffffff),
      w.doAbc(abc, "Avm1Movie"),
      w.symbolClass([[0, "Main"]]),
      w.showFrame(),
      w.showFrame(),
      w.showFrame(),
      w.end(),
    ],
  });
}

// Bitmap fills in an AVM1 SWF of `version`: a 4 x 4 bitmap, every pixel
// its own colour, at four times its size in a smoothed (0x41) and an
// unsmoothed (0x43) clipped fill, and a smoothed one the timeline moves a
// pixel in each of frames 2 to 4 and then leaves. Flash Player 32 (the
// browser plugin) leaves every bitmap fill of a SWF before 8 unsmoothed,
// still or moving, as Ruffle does, and smooths 0x41 from SWF 8 on; AIR's
// runtime smooths it in SWF 7 too, so adl draws the SWF 7 case from the same
// movie with `smoothed` an unsmoothed fill (0x43), as the plugin shows it.
function avm1BitmapSmoothing(version: number, smoothed: 0x41 | 0x43 = 0x41): Uint8Array {
  const pixels: number[] = [];
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      pixels.push(0xff, x * 80, y * 80, (x + y) % 2 === 0 ? 0xc0 : 0x20);
    }
  }

  const bitmap = w.tag(
    36,
    Uint8Array.from([1, 0, 5, 4, 0, 4, 0, ...zlibCompress(Uint8Array.from(pixels))]),
    true,
  );
  const square = (id: number, type: 0x41 | 0x43) =>
    w.shape({
      id,
      bounds: [0, 320, 0, 320],
      fills: [{ bitmap: 1, type, matrix: { a: 80, d: 80 } }],
      paths: [
        {
          fill1: 1,
          commands: [
            { move: [0, 0] },
            { line: [320, 0] },
            { line: [320, 320] },
            { line: [0, 320] },
            { line: [0, 0] },
          ],
        },
      ],
      version: 3,
    });
  const moved = (frame: number) =>
    w.place({ depth: 3, move: true, matrix: { tx: (10 + frame) * 20, ty: 60 * 20 } });

  return avm1Swf(
    version,
    [bitmap, square(10, smoothed), square(11, 0x43)],
    [
      [
        w.place({ depth: 1, character: 10, matrix: { tx: 10 * 20, ty: 10 * 20 } }),
        w.place({ depth: 2, character: 11, matrix: { tx: 50 * 20, ty: 10 * 20 } }),
        w.place({ depth: 3, character: 10, matrix: { tx: 11 * 20, ty: 60 * 20 } }),
      ],
      [moved(2)],
      [moved(3)],
      [moved(4)],
      [],
      [as1("stop();", version)],
    ],
  );
}

export const avm1Cases: PlayerCase[] = [
  ...[7, 8].map(
    (version): PlayerCase => ({
      name: `avm1-bitmap-smoothing-swf${version}`,
      swf: avm1BitmapSmoothing(version),
      ...(version < 8 ? { flash: avm1BitmapSmoothing(version, 0x43) } : {}),
      frames: 6,
      capture: [1, 4, 6],
      tolerance: 2,
      maxOutliers: 0,
    }),
  ),
  // AVM1's _width and _height on what has nothing to measure, as AS3's in
  // size-of-empty: an empty clip's scale is 0 both ways, a hairline's 0
  // across.
  {
    name: "avm1-size-of-empty",
    swf: () =>
      avm1Swf(
        8,
        [],
        [
          [
            as1(
              `var a = _root.createEmptyMovieClip("a", 1);
a._width = 42;
trace("avm1 empty after _width " + a._xscale + " " + a._yscale + " " + a._width + " " + a._height);
a.beginFill(0xff0000); a.moveTo(0, 0); a.lineTo(100, 0); a.lineTo(100, 100); a.lineTo(0, 100); a.endFill();
trace("avm1 filled later " + a._xscale + " " + a._yscale + " " + a._width + " " + a._height);
var b = _root.createEmptyMovieClip("b", 2);
b._height = 69;
trace("avm1 empty after _height " + b._xscale + " " + b._yscale);
var c = _root.createEmptyMovieClip("c", 3);
c.lineStyle(0, 0); c.moveTo(0, 0); c.lineTo(0, 100);
c._width = 42;
trace("avm1 hairline after _width " + c._xscale + " " + c._yscale + " " + c._width + " " + c._height);`,
              8,
            ),
          ],
        ],
      ),
    traced: true,
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  // Frame 1 is drawn at the outer SWF's INIT, before the AVM1 movies come at
  // that frame's end; the player draws the frame whole, with them.
  {
    name: "avm1-hello",
    swf: avm1Hello(),
    traced: true,
    frames: 4,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "avm1-script-masks",
    swf: maskSwf(),
    traced: true,
    frames: 5,
    capture: [2, 3, 4, 5],
    tolerance: 0,
    maxOutliers: 0,
  },
  ...[5, 6, 7, 8].map(
    (version): PlayerCase => ({
      name: `avm1-drawing-swf${version}`,
      swf: avm1Script("drawing", version),
      traced: true,
      frames: 2,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  {
    // BitmapData.draw of a clip with erase and alpha, as AS3's (draw-erase).
    name: "avm1-draw-erase",
    swf: avm1Script("draw-erase", 8),
    traced: true,
    frames: 2,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "avm1-draw-self",
    swf: avm1Script("draw-self", 8),
    traced: true,
    frames: 2,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  ...[7, 8].map(
    (version): PlayerCase => ({
      name: `avm1-drawing-frames-swf${version}`,
      swf: avm1Drawing(version),
      frames: 4,
      capture: [2, 4],
      // The curved strokes anti-alias within a pixel of Flash's, as for shared-lines.
      tolerance: 32,
      maxOutliers: 450,
    }),
  ),
  ...[false, true].map(
    (distant): PlayerCase => ({
      name: distant ? "avm1-backward-distant" : "avm1-backward-prefix",
      swf: backwardSwf(distant),
      traced: true,
      frames: 2,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[4, 5, 6, 7, 8, 10].map(
    (version): PlayerCase => ({
      name: `avm1-operators-swf${version}`,
      swf: avm1Operators(version),
      traced: true,
      frames: 2,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[5, 6, 7, 8, 10].map(
    (version): PlayerCase => ({
      name: `avm1-objects-swf${version}`,
      swf: avm1Objects(version),
      traced: true,
      frames: 2,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[5, 6, 7, 8, 10].map(
    (version): PlayerCase => ({
      name: `avm1-functions-swf${version}`,
      swf: avm1Functions(version),
      traced: true,
      frames: 3,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
      // Past its recursion limit Flash runs no AVM1 action again, a later SWF's neither.
      alone: true,
    }),
  ),
  ...[5, 6, 7, 8, 10].map(
    (version): PlayerCase => ({
      name: `avm1-control-swf${version}`,
      swf: avm1Control(version),
      traced: true,
      frames: 3,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...["array", "string", "number", "math", "classes", "broadcaster", "globals", "date"].flatMap(
    (name) =>
      [5, 6, 7, 8, 10].map(
        (version): PlayerCase => ({
          name: `avm1-${name}-swf${version}`,
          swf: avm1Script(name, version),
          traced: true,
          frames: 2,
          capture: [],
          tolerance: 0,
          maxOutliers: 0,
        }),
      ),
  ),
  ...[5, 6, 7, 8].map(
    (version): PlayerCase => ({
      name: `avm1-clips-swf${version}`,
      swf: avm1Clips(version),
      traced: true,
      frames: 4,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[5, 6, 7].map(
    (version): PlayerCase => ({
      name: `avm1-gotos-swf${version}`,
      swf: avm1Gotos(version),
      traced: true,
      frames: 5,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[5, 6, 7, 8].map(
    (version): PlayerCase => ({
      name: `avm1-frame-label-aliases-swf${version}`,
      swf: avm1FrameLabelAliases(version),
      traced: true,
      frames: 2,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[4, 5].map(
    (version): PlayerCase => ({
      name: `avm1-paths-swf${version}`,
      swf: avm1Paths(version),
      traced: true,
      frames: 2,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[5, 6, 7, 8].map(
    (version): PlayerCase => ({
      name: `avm1-scopes-swf${version}`,
      swf: avm1Scopes(version),
      traced: true,
      frames: 2,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  {
    name: "avm1-filters",
    swf: avm1Filters(),
    traced: true,
    frames: 2,
    capture: [2],
    // As the AS3 filters case: the page blurs at four samples a pixel, adl whole pixels.
    tolerance: 8,
    maxOutliers: 40,
  },
  {
    name: "avm1-clip-properties",
    swf: avm1ClipDrawn(),
    frames: 2,
    capture: [2],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "avm1-scale-ramp",
    swf: avm1ScaleRamp(),
    traced: true,
    frames: 102,
    // Flash may capture frame 1 before the AVM1 root's actions have run.
    capture: [2, 51, 101],
    tolerance: 0,
    maxOutliers: 0,
  },
  ...[5, 6, 7].map(
    (version): PlayerCase => ({
      name: `avm1-events-swf${version}`,
      swf: avm1Events(version),
      traced: true,
      frames: 6,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[6, 7, 8].map(
    (version): PlayerCase => ({
      name: `avm1-construct-swf${version}`,
      swf: avm1Construct(version),
      traced: true,
      frames: 3,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  {
    name: "avm1-hit-test-under-mask",
    swf: avm1HitTestUnderMask(10),
    traced: true,
    frames: 2,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  ...[false, true].map(
    (heroSwaps): PlayerCase => ({
      name: `avm1-rewind-swapped${heroSwaps ? "-other" : ""}`,
      swf: avm1RewindSwapped(6, heroSwaps),
      traced: true,
      frames: 8,
      capture: [8],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[6, 7, 8].map(
    (version): PlayerCase => ({
      name: `avm1-nan-names-swf${version}`,
      swf: avm1NanNames(version),
      traced: true,
      frames: 1,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[6, 8].map(
    (version): PlayerCase => ({
      name: `avm1-sound-volumes-swf${version}`,
      swf: avm1SoundVolumes(version),
      traced: true,
      frames: 1,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[5, 6, 7].map(
    (version): PlayerCase => ({
      name: `avm1-depths-swf${version}`,
      swf: avm1Depths(version),
      traced: true,
      frames: 3,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  {
    name: "avm1-initclip",
    swf: avm1Initclip(),
    traced: true,
    frames: 4,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
  ...[6, 7].map(
    (version): PlayerCase => ({
      name: `avm1-skipped-exports-swf${version}`,
      swf: skippedExports(version),
      traced: true,
      frames: 4,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  ...[6, 7].map(
    (version): PlayerCase => ({
      name: `avm1-timers-swf${version}`,
      swf: avm1Timers(version),
      traced: true,
      frames: 8,
      capture: [],
      tolerance: 0,
      maxOutliers: 0,
    }),
  ),
  {
    name: "avm1-recursion",
    swf: avm1Recursion(),
    traced: true,
    frames: 3,
    capture: [3],
    tolerance: 0,
    maxOutliers: 0,
    alone: true,
  },
  {
    name: "avm1-script-limits",
    swf: avm1ScriptLimits(),
    traced: true,
    frames: 3,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
    alone: true,
  },
  {
    name: "avm1-movie",
    build: avm1Movie,
    frames: 6,
    capture: [2, 3, 4, 5, 6],
    tolerance: 0,
    maxOutliers: 0,
  },
  {
    name: "legacy-xml",
    swf: (abc) => bare(abc, 1, "LegacyXml"),
    script: "LegacyXml",
    frames: 1,
    capture: [],
    tolerance: 0,
    maxOutliers: 0,
  },
];
