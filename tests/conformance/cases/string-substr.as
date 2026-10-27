// Negative lengths resolve start + length from the end when that sum is negative.
var s:String = "abcdef";
var dynamicString:* = s;
for each (var start:Number in [-Infinity, -2147483649, -9, -6, -2.9, -0.5, NaN, 0, 0.5, 1, 1.9, 3, 5, 6, 7, 9, 2147483648, Infinity]) {
  for each (var length:Number in [-Infinity, -2147483649, -9, -7, -6, -5, -4, -3, -2.9, -2, -1, -0.5, NaN, 0, 0.5, 1, 2, Infinity]) {
    trace(start, length, "[" + s.substr(start, length) + "]",
      "[" + dynamicString.substr(start, length) + "]",
      "[" + s.AS3::substr(start, length) + "]",
      "[" + String.prototype.substr.call(s, start, length) + "]");
  }
}

trace("defaults", s.substr(), s.substr(2), s.substr(2, undefined), s.substr(null, null));
trace("empty", "[" + "".substr(0, -1) + "]", "[" + "".substr(-1, 1) + "]");
function units(s:String):String {
  var result:Array = [];
  for (var i:int = 0; i < s.length; i++) {
    result.push(s.charCodeAt(i));
  }
  return result.join(",");
}
trace("utf16", units("A\uD83D\uDE00BC".substr(0, -1)), units("A\uD83D\uDE00BC".substr(-3, 2)));
trace("borrowed", String.prototype.substr.call({toString: function():String { return "abcdef"; }}, 1, -2));
var calls:String = "";
var from:Object = {valueOf: function():Number { calls += "start "; return 1; }};
var count:Object = {valueOf: function():Number { calls += "length"; return -2; }};
trace("coercion", dynamicString.substr(from, count), calls);

var target:Object = {perform: function():String { return "called"; }};
var method:String = "performer".substr(0, -2);
trace("computed", method, target[method]());
