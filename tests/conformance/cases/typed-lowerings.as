// What the emitter writes in less code once the verifier's types allow
// it: each section for one such lowering, run as avmshell runs it.
package {
  public class Base {
    public var name:String;
    public function Base(name:String) { this.name = name; }
    public function who():String { return "base " + name; }
    public function get size():int { return name.length; }
  }
}
package {
  public interface Named { function label():String; }
}
package {
  public class Derived extends Base implements Named {
    public function Derived(name:String) { super(name); }
    public function label():String { return "label " + name; }
  }
}

// Coercions to a class the value's own extends or implements.
function asBase(b:Base):String { return b == null ? "null base" : b.who(); }
function asNamed(n:Named):String { return n == null ? "null named" : n.label(); }

var d:Derived = new Derived("d");
trace(d.who(), d.size, asBase(d), asNamed(d));
var none:Derived = null;
trace(asBase(none), asNamed(none));
try {
  trace(none.who());
} catch (e:Error) {
  trace("call on null", e.errorID);
}

// Constants: negative ones under negation and subtraction, -0, NaN, and
// the same constant used on both sides of a branch.
var i:int = 5;
var n:Number = 2.5;
trace(i - -3, -(-7), i * -1, n - -0.5, 1 / -0, 1 / (0 * -1), -NaN);
trace(i > 3 ? -1 : 1, i < 3 ? 100 : -100, i >>> 1, -1 >>> 28, 0xffffffff, -2147483648);
var u:uint = 4294967295;
trace(u + 1, u >> 1, u >>> 1, u & -1);
var picked:String = i > 0 ? "pos" : "neg";
trace(picked, i == 5, i === 5, n != 2.5, null == undefined);

// Additions: strings with ints, uints, Booleans, null Strings and Numbers.
var s:String = "s";
var ns:String = null;
var b:Boolean = true;
trace(s + i, i + s, s + u, s + b, b + s, s + ns, ns + s, ns + i, ns + b, ns + ns);
trace("Loading " + int(37.9) + "%", s + n, s + 1e21, s + 0.1, s + -0, s + (-i));
trace(ns + n, b + i, b + b, s + s + i + u + b);

// Null checks: one per register until it is written, a loop's header
// entered again with the register written, and a branch's code in place.
function walk(start:Base, steps:int):String {
  var b:Base = start;
  var out:String = "";
  for (var k:int = 0; k < steps; k++) {
    out += b.name;
    out += b.size;
    if (k == 1) {
      b = null;
    }
  }
  return out;
}
trace(walk(d, 2));
try {
  trace(walk(d, 3));
} catch (e:Error) {
  trace("walked into null", e.errorID);
}
function twice(b:Base, drop:Boolean):String {
  var s:String = b.name;
  if (drop) {
    b = null;
  } else {
    s += b.size;
  }
  try {
    return s + b.name;
  } catch (e:Error) {
    return s + " then " + e.errorID;
  }
  return s;
}
trace(twice(d, false), twice(d, true));
var o:Object = {a: 1, b: 2};
var names:Array = [];
for (var key:String in o) {
  names.push(key);
}
names.sort();
trace(names, o.a + o.b);

// The count of arguments, with and without the default XML namespace.
function noXml(a:int, b:int):int { return a + b; }
function seesXml(a:int, b:int = 2):String { var x:XML = <x/>; return x.name() + (a + b); }
function setsXml(a:int):String { default xml namespace = "urn:a"; var x:XML = <y/>; return x.name() + a; }
trace(noXml(1, 2), seesXml(1), seesXml(1, 3), setsXml(4), new XML("<z/>").name());
var f:Function = noXml;
var g:Function = seesXml;
for each (var args:Array in [[], [1], [1, 2], [1, 2, 3]]) {
  try {
    trace(args.length, f.apply(null, args));
  } catch (e:ArgumentError) {
    trace(args.length, "noXml", e.errorID);
  }
  try {
    trace(args.length, g.apply(null, args));
  } catch (e:ArgumentError) {
    trace(args.length, "seesXml", e.errorID);
  }
}
