// AS2's classes in AVM1, by version (docs/avm1.md, "Classes"): Extends,
// InstanceOf, CastOp and ImplementsOp, the log's lines of a primitive where
// they take an object, and Function's objects.
function A(x) { this.x = x; trace("A ctor " + x); }
A.prototype.hello = function () { return "A.hello " + this.x; };
function B(x) { super(x); trace("B ctor"); }
__op("Extends", B, A);
trace("B.prototype keys " + (function (o) { var s = ""; ASSetPropFlags(o, null, 0, 1); for (var k in o) s += k + " "; return s; })(B.prototype));
trace("B.prototype.constructor " + (B.prototype.constructor == A) + " __constructor__ " + (B.prototype.__constructor__ == A) + " __proto__ " + (B.prototype.__proto__ == A.prototype));
var bb = new B(5);
trace("b.hello " + bb.hello());
trace("instanceof " + (bb instanceof B) + " " + (bb instanceof A) + " " + (bb instanceof Object) + " " + (bb instanceof Array) + " " + ([] instanceof Array) + " " + ([] instanceof Object));
trace("prim instanceof " + (5 instanceof Number) + " " + ("s" instanceof String) + " " + (new Number(5) instanceof Number) + " " + (true instanceof Boolean));
trace("instanceof non-fn " + (bb instanceof 5) + " " + (bb instanceof undefined) + " " + (bb instanceof {}) + " " + (undefined instanceof Object) + " " + (null instanceof Object));
var protoless = {}; protoless.prototype = A.prototype;
trace("instanceof obj with prototype " + (bb instanceof protoless));
trace("fn instanceof " + (A instanceof Function) + " " + (A instanceof Object));
// CastOp
trace("cast " + (__op("CastOp", A, bb) == bb) + " " + __op("CastOp", Array, bb) + " " + __op("CastOp", Number, 5) + " " + __op("CastOp", Object, "s") + " " + typeof __op("CastOp", undefined, bb));
// ImplementsOp
function I1() {} function I2() {} function I3() {}
function C() {}
__op("ImplementsOp", I1, I2, 2, C);
__op("ImplementsOp", I3, 1, I1);
var cc = new C();
trace("implements " + (cc instanceof C) + " " + (cc instanceof I1) + " " + (cc instanceof I2) + " " + (cc instanceof I3));
trace("cast iface " + (__op("CastOp", I2, cc) == cc) + " " + __op("CastOp", I3, cc));
function D() {}
__op("Extends", D, C);
var dd = new D();
trace("inherited iface " + (dd instanceof I1) + " " + (dd instanceof I3));
__op("ImplementsOp", 0, C);
trace("implements none " + (new C() instanceof I1) + " " + (cc instanceof I1));
__op("ImplementsOp", I2, 1, C);
trace("replaced " + (cc instanceof I1) + " " + (cc instanceof I2));
// Extends edge
function E() {}
__op("Extends", E, 5);
trace("extends 5 " + typeof E.prototype + " " + E.prototype.__proto__);
function F() {}
__op("Extends", F, undefined);
trace("extends undef " + typeof F.prototype);
var ee = new E();
trace("typeof " + typeof A + " " + typeof bb + " " + typeof B.prototype + " " + typeof Function.prototype + " " + typeof new A(1) + " " + typeof Object.prototype.toString);

// -- implements
function I1() {} function I2() {} function I3() {}
function K() {}
__op("ImplementsOp", I1, 1, K);
var k1 = new K();
__op("ImplementsOp", I2, 1, K);
var k2 = new K();
trace("a " + (k1 instanceof I1) + " " + (k1 instanceof I2) + " " + (k2 instanceof I1) + " " + (k2 instanceof I2));
function L() {}
__op("ImplementsOp", I1, I2, 2, L);
var l1 = new L();
trace("b " + (l1 instanceof I1) + " " + (l1 instanceof I2));
__op("ImplementsOp", I3, 1, L);
trace("c " + (l1 instanceof I1) + " " + (l1 instanceof I2) + " " + (l1 instanceof I3));
// interface of interface
function M() {}
__op("ImplementsOp", I3, 1, I1);
__op("ImplementsOp", I1, 1, M);
trace("d " + (new M() instanceof I3));
// prototype replaced after implements
function N() {}
__op("ImplementsOp", I1, 1, N);
N.prototype = {};
trace("e " + (new N() instanceof I1));
// count forms
function O() {}
__op("ImplementsOp", I1, "1", O);
trace("f " + (new O() instanceof I1));
function O2() {}
__op("ImplementsOp", I1, I2, 5, O2);
trace("g " + (new O2() instanceof I1) + " " + (new O2() instanceof I2));
function O3() {}
__op("ImplementsOp", I1, -1, O3);
trace("h " + (new O3() instanceof I1));
function O4() {}
__op("ImplementsOp", "x", I1, 2, O4);
trace("i " + (new O4() instanceof I1));
__op("ImplementsOp", I1, 1, 5);
trace("j");
function O5() {}
__op("ImplementsOp", I1, {}, O5);
trace("k " + (new O5() instanceof I1));
var plain = {}; plain.prototype = {};
__op("ImplementsOp", I1, 1, plain);
var x = {}; x.__proto__ = plain.prototype;
trace("l " + (x instanceof I1));
function O6() {} O6.prototype = 5;
__op("ImplementsOp", I1, 1, O6);
trace("m done");
function P1() {} function P2() {}
P2.prototype = new P1();
__op("ImplementsOp", I2, 1, P1);
var pz = new P2();
trace("n " + (pz instanceof I2) + " " + (pz instanceof P1));
trace("o cast " + (__op("CastOp", I2, pz) == pz) + " " + __op("CastOp", I3, 5) + " " + __op("CastOp", 5, pz) + " " + __op("CastOp", I1, null) + " " + __op("CastOp", I1, undefined));

// -- instanceof
function P() {}
var p = new P();
trace("1 new P instanceof P " + (p instanceof P) + " Object " + (p instanceof Object));
var q = {}; q.__proto__ = P.prototype;
trace("2 manual proto " + (q instanceof P));
function P2() {} P2.prototype = {};
trace("3 P2 replaced proto " + (new P2() instanceof P2));
function P3() {} P3.prototype = new P();
var p3 = new P3();
trace("4 P3 chain " + (p3 instanceof P3) + " " + (p3 instanceof P));
trace("5 P.prototype instanceof Object " + (P.prototype instanceof Object));
var o = {};
trace("6 {} instanceof Object " + (o instanceof Object));
function Q() {}
trace("7 typeof Q.prototype " + typeof Q.prototype + " " + (Q.prototype.constructor == Q));
var qq = new Q();
trace("8 qq.__proto__ == Q.prototype " + (qq.__proto__ == Q.prototype) + " instanceof " + (qq instanceof Q));
Q.prototype.x = 1;
trace("9 after member " + (new Q() instanceof Q) + " " + (qq instanceof Q));
function R() {}
var rp = R.prototype;
var r = new R();
trace("10 R " + (r instanceof R));
R.prototype = rp;
trace("11 R set again " + (r instanceof R) + " " + (new R() instanceof R));
function S() {}
S.prototype = new Object();
trace("12 S new Object " + (new S() instanceof S));
function T() {}
T.prototype = [];
trace("13 T array " + (new T() instanceof T));

// -- extends edges
function Sub() {}
__op("Extends", Sub, {});
trace("extends {} " + typeof Sub.prototype + " " + typeof Sub.prototype.__proto__ + " " + typeof Sub.prototype.__constructor__);
__op("Extends", 5, Object);
trace("extends prim sub");
function Sub2() {}
var sup = function () {}; sup.prototype = 7;
__op("Extends", Sub2, sup);
trace("extends prim proto " + typeof Sub2.prototype + " " + Sub2.prototype.__proto__);


// -- functions
var f = function (a, b) { return a + b; };
trace("typeof " + typeof f + " " + typeof Function + " " + typeof Function.prototype + " " + typeof f.prototype + " " + typeof f.call + " " + typeof Object.prototype.toString + " " + typeof Math.abs + " " + typeof String.fromCharCode);
trace("f " + f + " " + f.toString() + " " + (f + "") + " " + String(f) + " len " + f.length + " name " + f.name);
trace("Function " + Function + " " + Function(f) + " " + typeof Function() + " " + typeof new Function() + " " + (new Function(f) == f));
trace("Function.prototype " + Function.prototype + " " + Function.prototype.constructor + " " + (Function.prototype.constructor == Function) + " " + (f.constructor == Function) + " " + (f.__proto__ == Function.prototype));
trace("call apply " + f.call(null, 1, 2) + " " + f.apply(null, [3, 4]) + " " + f.apply(null) + " " + f.apply(null, "xy") + " " + f.apply(null, {length: 2, 0: 5, 1: 6}) + " " + f.call() + " " + Function.prototype.call.call(f, null, 7, 8));
trace("instanceof " + (f instanceof Function) + " " + (f instanceof Object) + " " + (Function instanceof Function) + " " + (Object instanceof Function) + " " + (Math.abs instanceof Function));
trace("valueOf " + (f.valueOf() == f) + " " + typeof f.valueOf());
trace("native fn props " + typeof Math.abs.prototype + " " + typeof Array.prototype.push.prototype + " " + typeof escape.prototype);
var nf = new Math.abs();
trace("new native " + typeof nf);
var ne = new escape("a b");
trace("new escape " + typeof ne + " " + ne);
f.prototype = 5;
trace("new with prim proto " + typeof new f() + " " + (new f()).__proto__);

// Which classes' prototypes a set, and Extends, can replace
var pnames = ["Object", "Function", "Array", "String", "Number", "Boolean", "AsBroadcaster", "Math"];
var ps = "";
for (var pi = 0; pi < pnames.length; pi++) {
  var pc = _global[pnames[pi]];
  var pbefore = pc.prototype;
  pc.prototype = {marker: 1};
  ps += pnames[pi] + ":" + (pc.prototype == pbefore ? "kept" : "set") + " ";
  pc.prototype = pbefore;
}
trace("prototype set " + ps);
var objectProto = Object.prototype;
var Sub = function () {};
__op("Extends", Object, Sub);
trace("Object extends " + (Object.prototype == objectProto) + " " + (new Sub() instanceof Object) + " " + ({} instanceof Object));
var numberProto = Number.prototype;
__op("Extends", Number, Sub);
trace("Number extends " + (Number.prototype == numberProto) + " " + (5 instanceof Number) + " " + (new Number(5) instanceof Number));
