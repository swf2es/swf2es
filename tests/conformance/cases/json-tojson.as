// Where JSON.stringify finds toJSON, on every value, primitives too: a
// public binding, a subclass's through its base, and never a script's AS3
// one, even alone (avmplus probes with the builtin's AS3 namespace); else the object's own dynamic one, then its prototype chain's.
// Also an Array's hole, looked for on its prototype chain, and own dynamic
// properties read where getProperty would.
package {
  public class Pub {
    public var x:int = 1;
    public function toJSON(k:String):* { return "pub:" + k; }
  }
  public class Both {
    public var x:int = 2;
    public function toJSON(k:String):* { return "public:" + k; }
    AS3 function toJSON(k:String):* { return "as3:" + k; }
  }
  public class Sub extends Pub {
    public var y:int = 3;
  }
  public dynamic class Dyn {
    public var z:int = 4;
  }
  public class OnlyAS3 {
    public var v:int = 6;
    AS3 function toJSON(k:String):* { return "as3:" + k; }
  }
  public class Plain {
    public var w:int = 5;
  }
}
function keys(s:String):String {
  var o:* = JSON.parse(s);
  if (o == null || typeof o != "object") return s;
  var k:Array = [];
  for (var n:String in o) k.push(n + "=" + (typeof o[n] == "object" ? JSON.stringify(o[n]) : o[n]));
  k.sort();
  return k.join(",");
}
trace("bound", JSON.stringify(new Pub()), JSON.stringify(new Both()), JSON.stringify(new Sub()), JSON.stringify([new Pub(), {k: new Sub()}]), JSON.stringify(new OnlyAS3()));
var d:Dyn = new Dyn();
trace("no toJSON", keys(JSON.stringify(d)), keys(JSON.stringify(new Plain())));
d.toJSON = function(k:String):* { return "own:" + k; };
trace("own", JSON.stringify(d), JSON.stringify({a: d}));
var plain:Object = {a: 1};
plain.toJSON = "not a function";
trace("not callable", keys(JSON.stringify(plain)));
Number.prototype.toJSON = function(k:String):* { return "n" + this; };
String.prototype.toJSON = function(k:String):* { return "s:" + this; };
trace("primitive prototypes", JSON.stringify([1, 2.5, "x", true]), JSON.stringify({n: 7}));
delete Number.prototype.toJSON;
delete String.prototype.toJSON;
Object.prototype.toJSON = function(k:String):* { return "object:" + k; };
trace("object prototype", JSON.stringify({a: {b: 1}}), JSON.stringify(new Plain()), JSON.stringify(1));
delete Object.prototype.toJSON;
trace("after delete", keys(JSON.stringify({a: {b: 1}})), JSON.stringify(1));
var holes:Array = [1];
holes[3] = 4;
trace("holes", JSON.stringify(holes));
Array.prototype[1] = "from prototype";
trace("hole from prototype", JSON.stringify(holes));
delete Array.prototype[1];
trace("numbers", keys(JSON.stringify({a: 0.1 + 0.2, b: 1e21, c: -0, d: 4294967295, e: 1e-7, f: 5e-324, g: 1.7976931348623157e308, h: 123456789012345680000})));
