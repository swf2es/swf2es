// Untyped gets, sets and calls of one name on objects of many kinds, which
// swf2es caches per name (property-cache.ts): each must still find what a
// full lookup finds, as objects of other classes, other namespaces,
// dynamic properties added and deleted, prototypes changed and classes
// loaded later come through the same names.
package late {
  public class Base {
    public function get x():String { return "Base's x"; }
    public function m():String { return "Base's m"; }
  }
}
import avmplus.Domain;
import flash.utils.ByteArray;
import flash.utils.Dictionary;
import flash.utils.Proxy;
import flash.utils.flash_proxy;
import late.Base;

namespace other = "urn:other";

// package late's Sub, which extends Base and overrides x and m.
const SUB:String =
  "10002e000000000b017800016d03537562046c617465044261736507537562277320780653747269" +
  "6e67075375622773206d064f626a6563740316021605000707010107010307020407020607010807" +
  "010a0500000000000501000005030000000000000000000001030401000402012200010221000203" +
  "000100010304000005010101000105d0302c07480000020101000105d0302c094800000300010000" +
  "01470000040101000106d030d04900470000000301000312d030650060063060042a3058001d1d68" +
  "03470000";
// package late's C, twice: with a String slot x and a method m, and dynamic,
// with a getter x and a Function slot m.
const LATE1:String =
  "10002e000000000a01780006537472696e671774686520666972737420646f6d61696e277320736c" +
  "6f74016d0143046c617465064f626a6563741974686520666972737420646f6d61696e2773206d65" +
  "74686f64031602160700060701010701030701050702060701080400000000000205000000000000" +
  "00000000010405010003020100000204010301000102000100010404000004010101000105d0302c" +
  "09480000020001000001470000030101000106d030d0490047000000030100020ed030650060052a" +
  "3058001d6804470000";
const LATE2:String =
  "10002e000000000c017800016d0846756e6374696f6e0143046c617465064f626a6563741a746865" +
  "207365636f6e6420646f6d61696e27732067657474657206537472696e6721746865207365636f6e" +
  "6420646f6d61696e27732066756e6374696f6e20736c6f74146c617465322e617324303a616e6f6e" +
  "796d6f75730316021606000707010107010307010407020507010707010905000000000006010000" +
  "060b0000000000000000000001040500000302010200010200000300040001000104040000050101" +
  "01000105d0302c084800000201010000032c0a48000003020100010dd03040025e022b6102d04900" +
  "47000004000100000147000000030100020ed030650060052a3058001d6804470000";

class A {
  public var x:int = 1;
  public function m():String { return "A's m"; }
}
// x in another namespace, which a public x does not see past.
class B extends A {
  other var x:String = "B's other x";
}
class G {
  private var v_:Number = 0;
  public function get x():Number { return v_; }
  public function set x(n:Number):void { v_ = n; }
  public function get readOnly():String { return "read only"; }
  public function set writeOnly(s:String):void { trace("writeOnly set", s); }
  public const k:String = "k";
  public var m:Function = function():String { return "G's function slot"; };
  public var a:A = null;
  public var i:int = 0;
}
dynamic class D {
  public var fixed:int = 5;
}
class NoX {
}
class P extends Proxy {
  public var x:int = 9;
  public function m():String { return "P's m"; }
  override flash_proxy function getProperty(name:*):* { return "proxy get " + name; }
  override flash_proxy function setProperty(name:*, value:*):void { trace("proxy set", name, value); }
  override flash_proxy function callProperty(name:*, ...rest):* { return "proxy call " + name; }
  override flash_proxy function hasProperty(name:*):Boolean { return true; }
  override flash_proxy function deleteProperty(name:*):Boolean { return true; }
}

function getX(o:*):* { return o.x; }
function setX(o:*, v:*):void { o.x = v; }
function callM(o:*):* { return o.m(); }
function getM(o:*):* { return o.m; }
function getY(o:*):* { return o.y; }
function setY(o:*, v:*):void { o.y = v; }
function callY(o:*):* { return o.y(); }
function getOtherX(o:*):* { use namespace other; return o.x; }
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e); }
}
function bytes(hex:String):ByteArray {
  var b:ByteArray = new ByteArray();
  for (var i:int = 0; i < hex.length; i += 2) {
    b.writeByte(parseInt(hex.substr(i, 2), 16));
  }
  return b;
}

// One name on objects of many classes, round and round, each its own binding.
var a:A = new A();
var b:B = new B();
var g:G = new G();
var d:D = new D();
var p:P = new P();
var base:Base = new Base();
var mixed:Array = [a, b, g, d, p, base, new NoX(), "abc", 5, a, g, b];
for (var round:int = 0; round < 3; round++) {
  for (var k:int = 0; k < mixed.length; k++) {
    var o:* = mixed[k];
    probe(round + " x of " + k, function():* { return getX(o); });
    probe(round + " m of " + k, function():* { return callM(o); });
    probe(round + " other x of " + k, function():* { return getOtherX(o); });
  }
}

// Sets coerce to the slot's type, or call the setter, whichever class.
for (round = 0; round < 2; round++) {
  setX(a, "12.7");
  setX(g, "3.5");
  setX(d, "dynamic x");
  trace("set", getX(a), getX(g), getX(d), getOtherX(b));
  setX(b, 4.9);
  trace("set B", getX(b), getOtherX(b));
}

// What a name cannot do on the class it is cached for still throws.
for (round = 0; round < 2; round++) {
  probe("read only", function():* { return g.readOnly; });
  probe("write read only", function():* { var o:* = g; o.readOnly = "no"; return "written"; });
  probe("write only", function():* { var o:* = g; o.writeOnly = "yes"; return "written"; });
  probe("read write only", function():* { var o:* = g; return o.writeOnly; });
  probe("write const", function():* { var o:* = g; o.k = "no"; return o.k; });
  probe("write A", function():* { var o:* = g; o.a = b; return o.a.x; });
  probe("write not an A", function():* { var o:* = g; o.a = "not an A"; return o.a; });
  probe("write int", function():* { var o:* = g; o.i = -3.9; return o.i; });
  probe("write method", function():* { var o:* = a; o.m = null; return "written"; });
  probe("NoX x", function():* { return getX(new NoX()); });
  probe("set NoX x", function():* { setX(new NoX(), 1); return "set"; });
}

// A method read is its closure, the same each time for one object.
var m1:* = getM(a);
var m2:* = getM(a);
var m3:* = getM(new A());
trace("closures", m1 === m2, m1 === m3, m1(), m3());
trace("Base's closure", getM(base) === getM(base), getM(base)());
trace("function slot", getM(g) === getM(g), callM(g));

// Dynamic properties added and deleted between calls, and the prototype's.
for (round = 0; round < 2; round++) {
  trace("y absent", getY(d));
  setY(d, 1);
  trace("y set", getY(d));
  delete d.y;
  trace("y deleted", getY(d));
  D.prototype.y = "D's prototype y";
  trace("prototype y", getY(d));
  setY(d, 2);
  trace("own y over the prototype's", getY(d));
  delete d.y;
  trace("prototype y again", getY(d));
  D.prototype.y = function():String { return "D's prototype function"; };
  trace("call prototype y", callY(d));
  setY(d, function():String { return "own function"; });
  trace("call own y", callY(d));
  delete d.y;
  trace("call prototype y again", callY(d));
  delete D.prototype.y;
  probe("call y gone", function():* { return callY(d); });
  trace("y gone", getY(d));
  setY(d, undefined);
  trace("y undefined", getY(d), "y" in d);
}

// Object's prototype seen by a plain Object and by a dynamic class's object.
var plain:Object = {};
for (round = 0; round < 2; round++) {
  trace("plain y", getY(plain), getY(d));
  Object.prototype.y = "Object's prototype y";
  trace("Object prototype y", getY(plain), getY(d));
  setY(plain, "own");
  trace("own plain y", getY(plain), getY(d));
  delete plain.y;
  delete Object.prototype.y;
}

// A prototype's method changed between calls.
for (round = 0; round < 2; round++) {
  A.prototype.pm = function():String { return "pm one"; };
  trace("pm", a.pm(), b.pm());
  A.prototype.pm = function():String { return "pm two"; };
  trace("pm changed", a.pm(), b.pm());
  delete A.prototype.pm;
  probe("pm gone", function():* { var o:* = a; return o.pm(); });
}

// A Proxy resolves the names its class does not bind.
for (round = 0; round < 2; round++) {
  trace("proxy", getX(p), getY(p), callM(p), callY(p));
  setX(p, "7");
  setY(p, "set through the proxy");
  trace("proxy x set", getX(p));
}

// A Dictionary keys by an object itself, and any other key as a name.
var dict:Dictionary = new Dictionary();
var key:Object = {};
for (round = 0; round < 2; round++) {
  dict[key] = "by the object";
  setY(dict, "by name");
  trace("dictionary", getY(dict), dict[key], dict["y"]);
  delete dict.y;
  trace("dictionary y deleted", getY(dict), dict[key]);
}

// Elements, by a name that is an index, are not dynamic properties.
function get0(o:*):* { return o["0"]; }
function set0(o:*, v:*):void { o["0"] = v; }
var arr:Array = ["zero"];
var vec:Vector.<String> = new <String>["vector zero"];
for (round = 0; round < 2; round++) {
  var dyn:D = new D();
  set0(dyn, "dynamic zero");
  trace("elements", get0(arr), get0(vec), get0(dyn));
  probe("a string's 0", function():* { return get0("str"); });
  set0(arr, "zero " + round);
  set0(vec, "vector " + round);
  setY(arr, "array y");
  trace("array", get0(arr), get0(vec), getY(arr), arr.length);
  probe("vector y", function():* { return getY(vec); });
}

// XML resolves its children's names before its methods' for a get.
var xml:XML = <a><x>child x</x><m>child m</m></a>;
for (round = 0; round < 2; round++) {
  trace("xml", getX(xml), getM(xml), xml.name());
  probe("xml m()", function():* { return callM(xml); });
}

// Class objects, whose statics are their own traits'.
for (round = 0; round < 2; round++) {
  setY(A, "A's y");
  trace("class y", getY(A), getY(B), getX(A), getX(Math));
}

// Classes loaded later, the same names on new traits: a subclass in a child
// domain, and two classes of one name in two domains.
var root:Domain = Domain.currentDomain;
var child:Domain = new Domain(root);
child.loadBytes(bytes(SUB));
var Sub:Class = child.getClass("late.Sub");
var sub:* = new Sub();
for (round = 0; round < 2; round++) {
  trace("sub", getX(base), getX(sub), callM(base), callM(sub), getX(a));
}

var first:Domain = new Domain(root);
first.loadBytes(bytes(LATE1));
var C1:Class = first.getClass("late.C");
var c1:* = new C1();
trace("first C", getX(c1), callM(c1), getX(a));
var second:Domain = new Domain(root);
second.loadBytes(bytes(LATE2));
var C2:Class = second.getClass("late.C");
var c2:* = new C2();
for (round = 0; round < 2; round++) {
  trace("two Cs", getX(c1), getX(c2), callM(c1), callM(c2), C1 === C2);
  probe("set the getter", function():* { setX(c2, "no"); return "set"; });
  setX(c1, 42);
  trace("first C's slot", getX(c1));
}
