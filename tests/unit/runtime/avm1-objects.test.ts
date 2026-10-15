// AVM1's objects, variables and builtins in node, each expectation what adl
// traces for the same code (the avm1-objects-swf* player cases trace them
// in Flash), where Ruffle's are not.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Avm1Object,
  DONT_DELETE,
  DONT_ENUM,
  get,
  type Host,
  keys,
  Runtime,
  set,
  type Value,
} from "../../../packages/runtime/dist/avm1/index.js";

const rt = new Runtime();
const host: Host = { trace() {}, play() {}, stop() {}, halt() {} };

/** An activation of a frame's code at `version`, its operations and its stack. */
function frame(version: number) {
  const root = rt.newObject();
  const cx = rt.activation([], [], {}, root, host);
  return { V: rt.version(version), cx, root, st: cx.st };
}

test("names are found whatever their case up to SWF 6, the first spelling kept", () => {
  const o = rt.newObject();
  set(o, "Ab", 1, 6);
  set(o, "aB", 2, 6);
  assert.equal(get(o, "AB", 6), 2);
  assert.deepEqual(keys(o, 6), ["Ab"]);

  set(o, "aB", 3, 7);
  assert.equal(get(o, "aB", 7), 3);
  assert.equal(get(o, "Ab", 7), 2);
  assert.equal(get(o, "ab", 7), undefined);
  assert.deepEqual(keys(o, 7), ["aB", "Ab"]);

  // The folded index follows a delete to the next spelling.
  const { V } = frame(6);
  assert.equal(V.deleteMember(frame(6).cx, "AB", o), true);
  assert.equal(get(o, "ab", 6), 3);
  assert.equal(get(o, "É", 6), undefined);
  set(o, "é", 4, 6);
  assert.equal(get(o, "É", 6), 4);
});

test("for..in lists a prototype's names first, then its own, the last added first", () => {
  const p = rt.newObject();
  for (const name of ["x", "c", "y"]) {
    set(p, name, 1, 7);
  }

  const o = rt.newObject();
  for (const name of ["a", "b", "c", "d"]) {
    set(o, name, 1, 7);
  }

  const { V, cx } = frame(7);
  V.deleteMember(cx, "b", o);
  set(o, "b", 1, 7);
  set(o, "__proto__", p, 7);
  assert.deepEqual(keys(o, 7), ["y", "x", "b", "d", "c", "a"]);

  // An own DontEnum property hides no prototype's.
  o.define("x", 1, DONT_ENUM);
  assert.deepEqual(keys(o, 7), ["y", "x", "b", "d", "c", "a"]);

  // Enumerate pushes undefined, then the names, the first on top.
  V.enumerate2(cx, p);
  assert.deepEqual(cx.st, [undefined, "x", "c", "y"]);
});

test("ASSetPropFlags sets and clears attributes, names found whatever their case", () => {
  const { V, cx, st } = frame(7);
  const f = rt.newObject();
  for (const name of ["a", "b", "c"]) {
    set(f, name, 1, 7);
  }

  st.push(2, "A,b", f, 3, "ASSetPropFlags");
  V.callFunction(cx);
  assert.equal(st.pop(), undefined);
  assert.equal(V.deleteMember(cx, "a", f), false);
  assert.equal(V.deleteMember(cx, "c", f), true);

  st.push(7, 0, null, f, 4, "ASSetPropFlags");
  V.callFunction(cx);
  assert.equal(V.deleteMember(cx, "a", f), true);
});

test("the version bits hide a property from earlier SWFs, until a set shows it", () => {
  const masks: [number, number[]][] = [
    [5, [0x80, 0x400, 0x1000, 0x2000, 0x4000]],
    [6, [0x100, 0x400, 0x1000, 0x2000, 0x4000]],
    [7, [0x1000, 0x2000, 0x4000]],
    [8, [0x2000, 0x4000]],
    [9, [0x4000]],
    [10, []],
  ];
  for (const [version, hidden] of masks) {
    for (const bits of [0x80, 0x100, 0x200, 0x400, 0x1000, 0x2000, 0x4000, 0x8000]) {
      const o = rt.newObject();
      o.define("v", "orig", bits);
      assert.equal(
        get(o, "v", version),
        hidden.includes(bits) ? undefined : "orig",
        `${version} ${bits}`,
      );
      set(o, "v", "set", version);
      // adl's SWF 6 keeps 0x400 through a set.
      const still = version === 6 && bits === 0x400;
      assert.equal(get(o, "v", version), still ? undefined : "set", `${version} ${bits}`);
    }
  }
});

test("addProperty takes a function getter and a function or null setter", () => {
  const { V, cx, st } = frame(7);
  const a = rt.newObject();
  const selfOf = get(rt.realm.objectProto, "valueOf", 7);
  const call = (...args: Value[]) => {
    st.push(...[...args].reverse(), args.length, a, "addProperty");
    V.callMethod(cx);
    return st.pop();
  };

  assert.equal(call(), false);
  assert.equal(call("p", selfOf), false);
  assert.equal(call("p", rt.newObject(), null), false);
  assert.equal(call("p", selfOf, rt.newObject()), false);
  assert.equal(call("", selfOf, null), false);
  assert.equal(call("p", selfOf, null), true);
  assert.equal(get(a, "p", 7), a);
  set(a, "p", 9, 7);
  assert.equal(get(a, "p", 7), a);

  // A getter on the prototype, which a set through the object leaves.
  const b = rt.newObject();
  set(b, "__proto__", a, 7);
  set(b, "p", 1, 7);
  assert.equal(get(b, "p", 7), b);
  assert.equal(b.own("p", 7), undefined);
});

test("watch gives the value set its callback's result, and is replaced by another", () => {
  const { V, cx, st } = frame(6);
  const w = rt.newObject();
  const call = (method: string, ...args: Value[]) => {
    st.push(...[...args].reverse(), args.length, w, method);
    V.callMethod(cx);
    return st.pop();
  };

  assert.equal(call("watch"), false);
  assert.equal(call("watch", "x", 5), false);
  assert.equal(call("watch", "x", get(rt.realm.objectProto, "valueOf", 6)), true);
  set(w, "x", 2, 6);
  assert.equal(get(w, "x", 6), w);
  assert.equal(call("watch", "x", rt.realm.Object), true);
  set(w, "x", 3, 6);
  const boxed = get(w, "x", 6) as Avm1Object;
  assert.equal(boxed.primitive, "x");
  assert.equal(call("unwatch", "X"), true);
  assert.equal(call("unwatch", "x"), false);
});

test("__resolve answers a name the chain lacks, a primitive one skipped", () => {
  const r = rt.newObject();
  set(r, "here", 1, 7);
  set(r, "__resolve", rt.realm.Object, 7);
  assert.equal((get(r, "missing", 7) as Avm1Object).primitive, "missing");
  assert.equal(get(r, "here", 7), 1);
  set(r, "__resolve", 5, 7);
  assert.equal(get(r, "missing", 7), undefined);
  set(r, "__resolve", rt.newObject(), 7);
  assert.equal(get(r, "missing", 7), undefined);
});

test("variables live on the root, paths reach objects' properties", () => {
  const { V, cx, root } = frame(7);
  V.setVariable(cx, 1, "x");
  assert.equal(get(root, "x", 7), 1);
  assert.equal(V.getVariable(cx, "x"), 1);
  assert.equal(V.getVariable(cx, "X"), undefined);
  assert.equal(frame(6).V.getVariable(cx, "X"), 1);

  const pa = rt.newObject();
  const b = rt.newObject();
  set(b, "c", "deep", 7);
  set(pa, "b", b, 7);
  V.setVariable(cx, pa, "pa");
  assert.equal(V.getVariable(cx, "pa.b.c"), "deep");
  assert.equal(V.getVariable(cx, "pa:b:c"), "deep");
  assert.equal(V.getVariable(cx, "this.x"), 1);
  V.setVariable(cx, "set", "pa.b.e");
  assert.equal(get(b, "e", 7), "set");
  V.setVariable(cx, 1, "nowhere.x");
  assert.equal(V.getVariable(cx, "nowhere"), undefined);

  // _global is below the root, and from SWF 6 a name.
  V.setMember(cx, "global", "gv", rt.realm.global);
  assert.equal(V.getVariable(cx, "gv"), "global");
  assert.equal(V.getVariable(cx, "_global"), rt.realm.global);
  assert.equal(rt.version(5).getVariable(cx, "_global"), undefined);

  V.defineLocal2(cx, "loc");
  assert.ok(root.own("loc", 7));
  assert.equal(V.deleteVariable(cx, "loc"), true);
  assert.equal(V.deleteVariable(cx, "loc"), false);
});

test("a primitive's members are its class's prototype's, its own length and constructor", () => {
  const { V, cx } = frame(6);
  assert.equal(V.getMember(cx, "length", "abc"), 3);
  assert.equal(V.getMember(cx, "LENGTH", "abc"), 3);
  assert.equal(rt.version(7).getMember(cx, "LENGTH", "abc"), undefined);
  assert.equal(V.getMember(cx, "constructor", 5), rt.realm.Number.constr);
  set(rt.realm.String.proto, "extra", "on String", 6);
  assert.equal(V.getMember(cx, "extra", "x"), "on String");
  assert.equal(V.getMember(cx, "extra", 1), undefined);
  assert.equal(V.getMember(cx, "x", undefined), undefined);
  assert.equal(V.getMember(cx, "x", null), undefined);
  assert.equal(V.deleteMember(cx, "extra", rt.realm.String.proto), true);
});

test("new gives an object its constructor before __constructor__, constructor up to SWF 6", () => {
  for (const [version, names] of [
    [6, ["__proto__", "constructor", "__constructor__"]],
    [7, ["__proto__", "__constructor__"]],
  ] as const) {
    const { V, cx, st } = frame(version);
    st.push(0, "Object");
    V.newObject(cx);
    const o = st.pop() as Avm1Object;
    assert.deepEqual([...o.props.keys()], names);
  }

  // InitObject's: constructor before __proto__, neither deletable.
  const { V, cx, st } = frame(7);
  st.push("a", 1, 1);
  V.initObject(cx);
  const o = st.pop() as Avm1Object;
  assert.deepEqual([...o.props.keys()], ["constructor", "__proto__", "a"]);
  assert.equal(o.own("constructor", 7)?.flags, DONT_ENUM | DONT_DELETE);

  // A count out of range pushes undefined and pops nothing else.
  st.push("kept", -1);
  V.initObject(cx);
  assert.deepEqual(st.splice(0), ["kept", undefined]);
});

test("InitArray's elements are popped first to last, its length follows a set", () => {
  const { V, cx, st } = frame(7);
  st.push("c", "b", "a", 3);
  V.initArray(cx);
  const a = st.pop() as Avm1Object;
  assert.deepEqual(keys(a, 7), ["2", "1", "0"]);
  assert.equal(get(a, "0", 7), "a");
  V.setMember(cx, "e", "4", a);
  assert.equal(get(a, "length", 7), 5);
  V.setMember(cx, 1, "length", a);
  assert.deepEqual(keys(a, 7), ["0"]);
  assert.equal(V.toString(a), "a");
});

test("objects convert by valueOf and toString, a missing method giving undefined", () => {
  const { V } = frame(7);
  const bare = new Avm1Object();
  assert.equal(V.equals2(bare, null), true);
  assert.equal(V.toString(bare), "[type Object]");
  assert.equal(V.add2("", bare), "undefined");
  assert.equal(V.typeOf(rt.realm.Object), "function");
  assert.equal(V.toString(rt.realm.Object), "[type Function]");
  // A SWF 5 sees no prototype of a function, so no toString either.
  assert.equal(rt.version(5).getMember(frame(5).cx, "toString", rt.realm.Object), undefined);
});
