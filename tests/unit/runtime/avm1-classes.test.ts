// AVM1's Array and String in node, each expectation what adl traces for
// the same code (the avm1-array-swf* and avm1-string-swf* player cases
// trace them in Flash), where Ruffle's are not; and how an array keeps its
// elements, apart while it is dense, in the Map once it has a hole.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Avm1Function,
  type Avm1Object,
  type Host,
  keys,
  Runtime,
  set,
  type Value,
} from "../../../packages/runtime/dist/avm1/index.js";

const rt = new Runtime();
const host: Host = { trace() {}, play() {}, stop() {}, halt() {} };
rt.realm.current = rt.activation([], [], {}, rt.newObject(), host);

const array = (...values: Value[]) => rt.realm.newArray(values, 7);

/** `self.name(...args)`, as CallMethod calls it in a SWF of `version`. */
function call(self: Value, name: string, args: Value[], version = 7): Value {
  const { V, cx } = frame(version);
  cx.st.push(...[...args].reverse(), args.length, self, name);
  V.callMethod(cx);
  return cx.st.pop();
}

function frame(version: number) {
  const cx = rt.activation([], [], {}, rt.newObject(), host);
  return { V: rt.version(version), cx };
}

const text = (a: Value) => call(a, "join", ["|"]);

test("an array keeps its elements apart while dense, in the Map from its first hole", () => {
  const a = array(1, 2, 3);
  assert.equal(a.elems?.length, 3);
  assert.equal(a.props.has("0"), false);

  call(a, "push", [4]);
  assert.equal(a.elems?.length, 4);
  set(a, "4", 5, 7);
  assert.equal(a.elems?.length, 5);
  assert.equal(text(a), "1|2|3|4|5");

  set(a, "7", 8, 7);
  assert.equal(a.elems, null);
  assert.equal(a.props.get("7")?.value, 8);
  assert.equal(call(a, "join", []), "1,2,3,4,5,undefined,undefined,8");
  assert.deepEqual(keys(a, 7), ["7", "4", "3", "2", "1", "0"]);
});

test("for..in lists elements and other names in the order they were set, as Flash does", () => {
  const x = array(1, 2);
  set(x, "foo", "bar", 7);
  call(x, "push", [3]);
  assert.deepEqual(keys(x, 7), ["2", "foo", "1", "0"]);

  // reverse deletes each pair and sets them again: they come last, in turn.
  call(x, "reverse", []);
  assert.deepEqual(keys(x, 7), ["2", "0", "foo", "1"]);
  assert.notEqual(x.elems, null);

  // sort sets again only what moved.
  const y = array(1, 2, 3);
  call(y, "sort", [16 | 2]);
  assert.deepEqual(keys(y, 7), ["2", "0", "1"]);
  assert.equal(text(y), "3|2|1");
});

test("a shorter length deletes the elements past it, but not those that cannot be", () => {
  const a = array(0, 1, 2, 3);
  set(a, "length", 2, 7);
  assert.equal(a.elems?.length, 2);

  const big = array();
  set(big, "length", 1e9, 7);
  set(big, "length", 0, 7);
  assert.equal(big.props.get("length")?.value, 0);

  // A length that is a string deletes nothing (adl).
  const s = array(0, 1, 2);
  set(s, "length", "3", 7);
  set(s, "length", 0, 7);
  assert.deepEqual(keys(s, 7), ["2", "1", "0"]);
});

test("sort calls a comparator as Flash's quicksort does, the leftmost the pivot", () => {
  const calls: string[] = [];
  const compare = new Avm1Function(undefined, rt.realm, (_, args) => {
    calls.push(`${args[0]}${args[1]}`);
    return (args[0] as number) - (args[1] as number);
  });
  const b = array(5, 3, 8, 1, 9, 2);
  call(b, "sort", [compare]);
  assert.equal(calls.join(" "), "53 58 52 52 51 59 58 59 51 13 12 13 32 98");
  assert.equal(text(b), "1|2|3|5|8|9");
});

test("sort's options and its overloads", () => {
  const values = () => array("b", "A", "c", "a", "B", 10, 9, 100);
  assert.equal(text(call(values(), "sort", [])), "10|100|9|A|B|a|b|c");
  assert.equal(text(call(values(), "sort", [1])), "10|100|9|A|a|b|B|c");
  assert.equal(text(call(values(), "sort", [3])), "c|B|b|a|A|9|100|10");
  assert.equal(text(call(array(10, 9, 100, 1.5, -3, "7"), "sort", [16])), "-3|1.5|9|10|100|7");
  assert.equal(text(call(array(3, 1, 2), "sort", [8])), "1|2|0");
  assert.equal(call(array(3, 1, 3), "sort", [4]), 0);
  assert.equal(call(array(3, 1, 2), "sort", [undefined]), undefined);
  assert.equal(call(array(3, 1, 2), "sort", ["x"]), undefined);
  // An object that is no function sorts by the default order (adl).
  assert.equal(text(call(array(3, 1, 2), "sort", [rt.newObject()])), "1|2|3");
});

test("splice and unshift take adl's arguments, and splice gives undefined where it does nothing", () => {
  assert.equal(call(array(0, 1, 2), "splice", []), undefined);
  assert.equal(call(array(0, 1, 2), "splice", [1, undefined]), undefined);
  assert.equal(call(array(0, 1, 2), "splice", [1, -1]), undefined);
  const p = array(0, 1, 2, 3, 4);
  assert.equal(text(call(p, "splice", [1, 1, "a", "b", "c"])), "1");
  assert.equal(text(p), "0|a|b|c|2|3|4");
  assert.equal(call(p, "unshift", []), 7);
  assert.equal(call(p, "unshift", ["x", "y"]), 9);
  assert.equal(text(p), "x|y|0|a|b|c|2|3|4");
});

test("join's separator converts as the version converts undefined", () => {
  assert.equal(call(array(1, 2), "join", [undefined], 6), "12");
  assert.equal(call(array(1, 2), "join", [undefined], 7), "1undefined2");
  assert.equal(call(array(1, 2), "join", [null], 7), "1null2");
});

test("String's methods take a string unboxed, and adl's edges", () => {
  const s = "Hello, World";
  assert.equal(call(s, "charCodeAt", [100], 5), 0);
  assert.ok(Number.isNaN(call(s, "charCodeAt", [100], 6) as number));
  assert.equal(call(s, "lastIndexOf", ["o", -5]), -1);
  assert.equal(call(s, "lastIndexOf", ["lo", 3]), 3);
  assert.equal(call(s, "substr", [2, -1]), "");
  assert.equal(call(s, "slice", []), undefined);
  assert.equal(call(s, "indexOf", [undefined], 6), 0);
  assert.equal(call(s, "indexOf", [undefined], 7), -1);
});

test("a SWF 5 splits only at one character, and at commas by default", () => {
  const parts = (s: string, args: Value[], version: number) =>
    text(call(s, "split", args, version));
  assert.equal(parts("a--b--c", ["--"], 5), "a--b--c");
  assert.equal(parts("a--b--c", ["--"], 6), "a|b|c");
  assert.equal(parts("a,b,c", [""], 5), "a,b,c");
  assert.equal(parts("a,b,c", [""], 6), "a|,|b|,|c");
  assert.equal(parts("a,b,c", [], 5), "a|b|c");
  assert.equal(parts("a,b,c", [], 6), "a,b,c");
});

test("case mappings are Flash's own, one code unit to one", () => {
  assert.equal(call("ÀÉÎ İ Σ ß ẞ", "toLowerCase", []), "àéî i σ ß ẞ");
  assert.equal(call("àéî ı σ ς ß ẞ ÿ ﬀ", "toUpperCase", []), "ÀÉÎ I Σ ΢ ß ẞ Ÿ ﬀ");
});

test("a String object's toString is its string; valueOf gives any other object itself", () => {
  const o = rt.newObject();
  const method = (name: string) =>
    (rt.realm.String.proto as Avm1Object).own(name, 7)?.value as Avm1Function;
  assert.equal(method("valueOf").call(o, [], 7), o);
  assert.equal(method("toString").call(o, [], 7), undefined);
});
