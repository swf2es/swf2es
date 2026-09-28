// JSON.stringify's output compared by what it reads back as: key order,
// escapes and numbers' digits are free. Where calls are traced, the values
// are arrays or have one key, as avmplus orders an object's keys by its
// hashtable.
function back(s:*):String {
  if (s === undefined) return "undefined";
  return canon(JSON.parse(s));
}
function canon(v:*):String {
  if (v === null || typeof v != "object") return typeof v + ":" + v;
  var parts:Array = [];
  if (v is Array) {
    for (var i:int = 0; i < v.length; i++) parts.push(canon(v[i]));
    return "[" + parts.join(",") + "]";
  }
  for (var k:String in v) parts.push(k + "=" + canon(v[k]));
  parts.sort();
  return "{" + parts.join(",") + "}";
}
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, "threw", e.errorID); }
}
var o:Object = {};
o["__proto__"] = 1;
o.a = {__proto__: 2};
probe("__proto__", function():* { return back(JSON.stringify(o)); });
var calls:Array = [];
var replacer:Function = function(k:String, v:*):* {
  calls.push((this is Array ? "array" : typeof this) + "/" + k + "/" + (v === null || typeof v != "object" ? String(v) : v is Array ? "array" : "object"));
  return v;
};
probe("replacer order", function():* { var s:String = JSON.stringify([1, [2, {x: 3}], "s"], replacer); return back(s) + " " + calls.join(" "); });
probe("drop keys", function():* { return back(JSON.stringify({keep: 1, drop: 2, n: {drop: 3, k: 4}}, function(k:String, v:*):* { return k == "drop" ? undefined : v; })); });
probe("list", function():* { return back(JSON.stringify({a: 1, b: 2, c: {a: 3, d: 4}}, ["a", "c", "missing", "a"])); });
probe("list numbers", function():* { return back(JSON.stringify({1: "one", 2: "two"}, [1])); });
probe("gap long", function():* { return JSON.stringify([1, {a: [2]}], null, "abcdefghijklmnop"); });
probe("gap number", function():* { return JSON.stringify({a: [1, 2]}, null, 20); });
probe("gap empty containers", function():* { return JSON.stringify([[], {}, {a: []}], null, 1); });
probe("toJSON object", function():* { return back(JSON.stringify({a: {toJSON: function(k:String):* { return {inner: k, list: [k]}; }}})); });
probe("toJSON function", function():* { return back(JSON.stringify({a: 1, b: {toJSON: function(k:String):* { return function():void {}; }}})) + " " + JSON.stringify([{toJSON: function(k:String):* { return function():void {}; }}]); });
probe("toJSON undefined", function():* { return back(JSON.stringify([{toJSON: function(k:String):* { return undefined; }}])); });
var loop:Object = {};
probe("toJSON cycle", function():* { return back(JSON.stringify({a: {toJSON: function(k:String):* { return loop; }}, b: loop})); });
loop.self = {toJSON: function(k:String):* { return loop; }};
probe("toJSON cycle back", function():* { return JSON.stringify(loop); });
probe("shared not a cycle", function():* { var s:Object = {v: 1}; return back(JSON.stringify([s, s, {s: s}])); });
probe("vector of objects", function():* { return back(JSON.stringify(new <Object>[{a: 1}, null, [2]])); });
probe("vector of strings", function():* { return back(JSON.stringify(new <String>["x", null, "y"])); });
probe("top level", function():* { return [JSON.stringify(undefined), JSON.stringify(function():void {}), JSON.stringify(null), JSON.stringify("s"), JSON.stringify(NaN), JSON.stringify(-Infinity)].join(" "); });
probe("in array", function():* { return JSON.stringify([undefined, function():void {}, NaN, Infinity, -0]); });
probe("strings", function():* { var s:String = "q\"b\\s/\b\f\n\r\t" + String.fromCharCode(0, 31, 127, 0x2028, 0xd800, 0xdc00, 0xd83d, 0xde00) + "é"; var r:String = JSON.parse(JSON.stringify(s)); var codes:Array = []; for (var i:int = 0; i < r.length; i++) codes.push(r.charCodeAt(i).toString(16)); return (r == s) + " " + codes.join(","); });
probe("keys escaped", function():* { var k:Object = {}; k["a\"b"] = 1; k["\n"] = 2; k[""] = 3; return back(JSON.stringify(k)); });
probe("date", function():* { return back(JSON.stringify({d: new Date(0)})).length > 10; });
probe("boxed", function():* { return back(JSON.stringify([new Number(3), new String("s"), new Boolean(false)])); });
