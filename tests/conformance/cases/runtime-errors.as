// The errors the runtime throws, by number: argument counts, coercions,
// calls of non-functions, reads of missing names, and writes the traits
// do not allow.
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
