// Reusing number formatting must still visit Array's coercion hooks on every call.
var coordinate:Number = 209.14077758789063;
for (var i:int = 0; i < 3; i++) {
  trace(String(coordinate), Number([coordinate]), 300 - [coordinate]);
}

var calls:int = 0;
var originalValueOf:Function = Array.prototype.valueOf;
Array.prototype.valueOf = function():* {
  calls++;
  return this;
};
for (i = 0; i < 3; i++) {
  trace(Number([coordinate]), calls);
}
Array.prototype.valueOf = originalValueOf;

var originalToString:Function = Array.prototype.toString;
Array.prototype.toString = function():String {
  calls++;
  return calls % 2 == 0 ? "7" : "8";
};
for (i = 0; i < 3; i++) {
  trace(Number([coordinate]), calls);
}
Array.prototype.toString = originalToString;
trace(Number([coordinate]), 1 / Number([-0]), Number([NaN]), Number([Infinity]));
