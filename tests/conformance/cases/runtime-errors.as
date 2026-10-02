// The errors the runtime throws, by number: argument counts, coercions,
// calls of non-functions, reads of missing names, and writes the traits
// do not allow.
package {
  public interface IEmpty {}
}
package {
  public class Empty implements IEmpty {}
}
package {
  public class Thing {
    public const fixed:int = 1;
    public function method(a:int, b:int):int { return a + b; }
    public function get readOnly():int { return 2; }
  }
}
function probe(name:String, f:Function):void {
  try { f(); trace(name, "ok"); } catch (e:Error) { trace(name, e.errorID, Object(e).constructor == TypeError, Object(e).constructor == ReferenceError, Object(e).constructor == ArgumentError); }
}
var t:Thing = new Thing();
var o:* = t;
var n:* = null;
var u:*;
probe("too few", function():void { o.method(1); });
probe("too many", function():void { o.method(1, 2, 3); });
probe("null property", function():void { n.x; });
probe("undefined property", function():void { u.x; });
probe("call non-function", function():void { var v:* = 5; v(); });
probe("call missing", function():void { o.nothing(); });
probe("undefined name", function():void { return undefinedVariable; });
probe("coerce", function():void { var s:Thing = Object("str") as Thing; var c:Thing = Thing(Object(new Object())); });
probe("write const", function():void { o.fixed = 2; });
probe("write getter", function():void { o.readOnly = 3; });
probe("write method", function():void { o.method = null; });
probe("new non-constructor", function():void { var v:* = 1; new v(); });
probe("instanceof", function():void { var r:* = t instanceof 1; });
probe("range", function():void { new Array(-1); });
probe("vector index", function():void { var v:Vector.<int> = new Vector.<int>(2); v[5]; });
probe("fixed vector", function():void { var v:Vector.<int> = new Vector.<int>(2, true); v.push(1); });
probe("radix", function():void { (5).toString(1); });
probe("precision", function():void { (5).toFixed(30); });
// new o.f() on a primitive looks f up on its prototype: a missing one is
// undefined, which is no constructor; one set there constructs.
function construct(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e); }
}
var cns:Namespace = new Namespace("u");
construct("new on int", function():* { var n:* = 1; return new n.missing(); });
construct("new on String", function():* { var s:* = "s"; return new s.missing(); });
construct("new on Namespace", function():* { var n:* = cns; return new n.missing(); });
construct("new on null", function():* { var n:* = null; return new n.missing(); });
construct("new on undefined", function():* { var n:* = undefined; return new n.missing(); });
String.prototype.made = String;
construct("new from prototype", function():* { var s:* = "s"; return "[" + new s.made() + "]"; });
delete String.prototype.made;
// ToPrimitive calls valueOf and toString as properties: one that is not a
// function fails as a call does; an object result goes on to the other.
function NoValueOf() { this.valueOf = undefined; }
function ObjectValueOf() { this.valueOf = function():* { return {}; }; this.toString = function():* { return "s"; }; }
construct("valueOf undefined", function():* { return new NoValueOf() + 1; });
construct("valueOf object", function():* { return new ObjectValueOf() + 1; });
// as with what is not a class: a primitive as null, an object not a class 1041.
construct("as string", function():* { var t:* = "hello"; return 1 as t; });
construct("as undefined", function():* { var t:* = undefined; return 1 as t; });
construct("as namespace", function():* { var t:* = cns; return 1 as t; });
construct("as object", function():* { var t:* = {}; return 1 as t; });
// A missing name read through an interface's namespace set.
construct("interface read", function():* { var e:IEmpty = new Empty(); return e["x"] + " " + Object(e).missing; });
construct("interface ns read", function():* { var e:IEmpty = new Empty(); return e.missing; });
// x.* reads every name: an object's namespace set fails with 1081, a primitive's with 1069.
construct("wildcard object", function():* { var o:* = {a: 1}; return o.*; });
construct("wildcard array", function():* { var a:* = [1]; return a.*; });
construct("wildcard string", function():* { var s:* = "s"; return s.*; });
construct("wildcard namespace", function():* { var n:* = cns; return n.*; });
