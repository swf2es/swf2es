// Properties an object does not have: called, read, called for effect,
// constructed and written, on sealed and dynamic objects, Vectors (sealed
// but for their elements, as VectorBaseObject refuses any other name),
// primitives (whose calls look on their prototype), null and undefined.
package {
  public class Sealed { public var x:int = 1; public function m():int { return 2; } }
  public dynamic class Open { }
}
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e.errorID, e is ReferenceError ? "ReferenceError" : e is TypeError ? "TypeError" : "other"); }
}
var sealed:* = new Sealed();
var open:* = new Open();
var v:* = new <int>[1];
var arr:* = [1];
var n:* = 5;
var s:* = "str";
var f:* = function():void {};
var obj:* = {};
var dt:* = new Date(0);
var nul:* = null;
var und:* = undefined;
var cls:* = Sealed;
probe("call sealed", function():* { return sealed.nope(); });
probe("call open", function():* { return open.nope(); });
probe("call vector", function():* { return v.nope(); });
probe("call array", function():* { return arr.nope(); });
probe("call int", function():* { return n.nope(); });
probe("call string", function():* { return s.nope(); });
probe("call function", function():* { return f.nope(); });
probe("call object", function():* { return obj.nope(); });
probe("call date", function():* { return dt.nope(); });
probe("call null", function():* { return nul.nope(); });
probe("call undefined", function():* { return und.nope(); });
probe("call class", function():* { return cls.nope(); });
probe("call sealed field", function():* { return sealed.x(); });
probe("read sealed", function():* { return sealed.nope; });
probe("read open", function():* { return open.nope; });
probe("read vector", function():* { return v.nope; });
probe("read int", function():* { return n.nope; });
probe("read string", function():* { return s.nope; });
probe("read class", function():* { return cls.nope; });
probe("void sealed", function():* { sealed.nope(); return "ok"; });
probe("void open", function():* { open.nope(); return "ok"; });
probe("new sealed", function():* { return new sealed.nope(); });
probe("new open", function():* { return new open.nope(); });
probe("new vector", function():* { return new v.nope(); });
probe("write sealed", function():* { sealed.nope = 1; return "ok"; });
probe("write vector", function():* { v.nope = 1; return "ok"; });
probe("call typed sealed", function():* { var t:Sealed = new Sealed(); return Object(t).nope(); });
probe("delete sealed", function():* { return delete sealed.nope; });
probe("in sealed", function():* { return "nope" in sealed; });
probe("call global", function():* { return nopeGlobal(); });
// A sealed Vector still has its elements, its prototype's properties, and a primitive its prototype's methods.
Object.prototype.shared = 5;
Number.prototype.twice = function():Number { return this * 2; };
probe("vector proto", function():* { return v.shared; });
probe("vector own", function():* { return v.hasOwnProperty("0") + " " + ("0" in v) + " " + ("nope" in v); });
probe("vector for-in", function():* { var ks:Array = []; for (var k:String in v) ks.push(k); return ks.join(","); });
probe("int proto method", function():* { return n.twice(); });
delete Object.prototype.shared;
delete Number.prototype.twice;
