// Small ways the builtins behave in avmplus: the errors of calls and
// constructions they refuse, the super operations by the base's traits
// alone, a prototype's constructor not enumerated, and a few natives'
// edges (lengths, splitting and comparing strings, a NUL in a number,
// isPrototypeOf of a primitive, a Vector's in and pop).
package {
  public class Base { public function f():String { return "base"; } }
  public class Sub extends Base {
    public function callMissing():* { return super["missing"](); }
    public function getMissing():* { return super["missing"]; }
    public function setMissing():* { super["missing"] = 1; return "set"; }
    public function callF():* { return super.f(); }
  }
}
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, "error", e.errorID); }
}

probe("Function()", function():* { return typeof Function() + " " + typeof new Function(); });
probe("Function(body)", function():* { return Function("return 1"); });
probe("new Function(body)", function():* { return new Function("a", "return a"); });
probe("Math()", function():* { var m:* = Math; return m(); });
probe("new Math()", function():* { var m:* = Math; return new m(); });
probe("new JSON()", function():* { var j:* = JSON; return new j(); });
probe("new method", function():* { var o:Base = new Base(); var f:* = o.f; return new f(); });
probe("new RegExp(re, flags)", function():* { return new RegExp(/a/, "g"); });
probe("new RegExp(re)", function():* { return new RegExp(/a/g).source; });
probe("apply of a non-array", function():* { return (function():* { return 1; }).apply(null, 5); });
probe("apply of null", function():* { return (function():* { return arguments.length; }).apply(null, null); });
probe("delete a string's length", function():* { var s:* = ""; return delete s.length; });
probe("delete a number's", function():* { var n:* = 1; return delete n.x; });
probe("super call missing", function():* { return new Sub().callMissing(); });
probe("super get missing", function():* { return new Sub().getMissing(); });
probe("super set missing", function():* { return new Sub().setMissing(); });
probe("super call", function():* { return new Sub().callF(); });
probe("for in a class", function():* { var s:String = ""; for (var p:String in Object) s += p; for (p in Array) s += p; for (p in Math) s += p; return "[" + s + "]"; });
probe("for in a function's prototype", function():* { var s:String = ""; var f:Function = function():void {}; for (var p:String in f.prototype) s += p; return "[" + s + "]"; });
probe("lengths", function():* { return [Math.max.length, Math.min.length, Number.max.length, Number.min.length].join(","); });
probe("max min", function():* { return [Math.max(), Math.min(), Math.max(1, 5, 3), Math.min(4, 2, 9), Math.max(1, NaN)].join(","); });
probe("split empty", function():* { return ["".split("").length, "".split(",").length, "".split(/x/).length, "".split("", 0).length].join(","); });
probe("localeCompare", function():* { return ["a".localeCompare("A"), "abc".localeCompare("abd"), "ab".localeCompare("abc"), "b".localeCompare("b"), "abc".localeCompare("ab")].join(","); });
probe("NUL in a number", function():* { return [Number("4" + String.fromCharCode(0) + "4"), Number("4.2" + String.fromCharCode(0)), Number(String.fromCharCode(0) + "1")].join(","); });
probe("isPrototypeOf a primitive", function():* { return [String.prototype.isPrototypeOf("x"), Object.prototype.isPrototypeOf(1), Number.prototype.isPrototypeOf("x")].join(","); });
probe("vector in", function():* { var v:Vector.<int> = new <int>[1, 2]; return [0 in v, 2 in v, -2 in v, 1.1 in v, "1.1" in v, "push" in v].join(","); });
probe("vector pop empty", function():* { return [new Vector.<Object>().pop(), new Vector.<int>().pop(), new Vector.<Number>().shift(), new Vector.<String>().pop()].join(","); });
