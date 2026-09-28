// Objects: literals, dynamic properties, delete, hasOwnProperty, the
// prototype chain, and iteration with for-in and for each.
var o:Object = {a: 1, b: "two", c: null};
o.d = [1, 2];
delete o.b;
trace(o.a, o.b, o.c, o.d.length, o.hasOwnProperty("a"), o.hasOwnProperty("b"), "c" in o);
var keys:Array = [];
for (var k:String in o) keys.push(k);
keys.sort();
trace("keys", keys);
var sum:int = 0;
for each (var v:* in {x: 1, y: 2, z: 3}) sum += v;
trace("values", sum);
var arr:Array = [10, 20, 30];
var idx:Array = [];
for (var i:* in arr) idx.push(i, typeof i);
trace("indices", idx);
function Point(x:Number, y:Number):void { this.x = x; this.y = y; }
Point.prototype.len = function():Number { return Math.sqrt(this.x * this.x + this.y * this.y); };
var p:* = new Point(3, 4);
trace("prototype", p.len(), p.hasOwnProperty("len"), p.constructor == Point, p instanceof Point);
Object.prototype.shared = "yes";
trace("shared", ({}).shared, p.shared);
delete Object.prototype.shared;
trace("unshared", ({}).shared);
trace(String({}), String([1, [2, 3]]), String(null), String(undefined), Object(3) + 1);
var nested:Object = {inner: {deep: {value: 42}}};
trace(nested.inner.deep.value, nested["inner"]["deep"]["value"]);
o.setPropertyIsEnumerable("a", false);
keys = [];
for (k in o) keys.push(k);
keys.sort();
trace("hidden", keys, o.propertyIsEnumerable("a"), o.propertyIsEnumerable("c"));
