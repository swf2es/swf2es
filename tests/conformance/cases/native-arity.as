// A native called with too few or too many arguments, where the verifier
// could not bind the call and so did not check it: through an untyped
// receiver, a method closure, or a script function by name. ArgumentError
// 1063, as avmplus' argcOk gives it; a bound call with the right count, and
// a native that takes the rest, are unaffected.
import flash.utils.ByteArray;

function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, "error", e.errorID); }
}

var x:* = <a/>;
var s:* = "abc";
var b:* = new ByteArray();
probe("untyped, too few", function():* { return x.addNamespace(); });
probe("untyped, too many", function():* { return s.charAt(0, 1, 2); });
probe("untyped, right", function():* { return s.charAt(1); });
probe("byte array, too many", function():* { b.writeByte(1, 2); return b.length; });
probe("byte array, too few", function():* { b.writeByte(); return b.length; });
probe("closure, too many", function():* { var f:Function = s.charAt; return f(0, 1); });
probe("closure, too few", function():* { var t:* = new ByteArray(); var f:Function = t.writeByte; return f(); });
probe("closure, right", function():* { var f:Function = s.indexOf; return f("c"); });
probe("rest", function():* { return Math.max(1, 5, 3) + " " + s.concat("d", "e", "f"); });
probe("by name, too few", function():* { var g:* = this; return isNaN(); });
probe("typed, right", function():* { var t:ByteArray = new ByteArray(); t.writeByte(7); return t.length; });
