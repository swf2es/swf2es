// Array's prototype functions called on what is not an Array: through its
// length and its indexed properties, as avmplus' generic functions go.
import flash.utils.ByteArray;
function WithLength(n:uint) {
  this.length = n;
  for (var i:uint = 0; i < n; i++) {
    this[i] = i * 10;
  }
}
function show(o:*):String {
  var parts:Array = [];
  for (var i:uint = 0; i < o.length; i++) {
    parts.push(o[i]);
  }
  return o.length + "[" + parts.join(",") + "]";
}
function each(name:String, f:Function):void {
  var v:Vector.<int> = new <int>[1, 2, 3, 4];
  var b:ByteArray = new ByteArray();
  b.writeByte(1); b.writeByte(2); b.writeByte(3); b.writeByte(4);
  var o:Object = new WithLength(4);
  var out:Array = [];
  for each (var x:* in [v, b, o]) {
    try { out.push(f(x) + " " + show(x)); } catch (e:Error) { out.push(String(e)); }
  }
  trace(name, out.join(" | "));
}
var P:Object = Array.prototype;
each("pop", function(x:*):* { return P.pop.call(x); });
each("shift", function(x:*):* { return P.shift.call(x); });
each("reverse", function(x:*):* { P.reverse.call(x); return ""; });
each("slice", function(x:*):* { return P.slice.call(x, 1, -1).join(","); });
each("splice", function(x:*):* { return P.splice.call(x, 1, 2).join(","); });
each("splice in", function(x:*):* { return P.splice.call(x, 1, 1, 7, 8).join(","); });
each("indexOf", function(x:*):* { return P.indexOf.call(x, 3) + " " + P.indexOf.call(x, 30) + " " + P.indexOf.call(x, 3, -1); });
each("lastIndexOf", function(x:*):* { return P.lastIndexOf.call(x, 2) + " " + P.lastIndexOf.call(x, 20, 1); });
each("concat", function(x:*):* { return P.concat.call(x, [5], 6).join(","); });
trace(P.pop.call("s"), P.shift.call(1), P.indexOf.call(null, 1), P.slice.call(true));
var empty:Object = new WithLength(0);
P.pop.call(empty);
trace(empty.length, P.shift.call({}), P.reverse.call({length: 1, 0: "a"})[0]);
