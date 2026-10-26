// Reusing number formatting must still visit Array's coercion hooks on every call.
var coordinate:Number = 209.14077758789063;
for (var i:int = 0; i < 3; i++) {
  trace(String(coordinate), String([coordinate]), String([coordinate]));
}

var calls:int = 0;
var originalValueOf:Function = Array.prototype.valueOf;
Array.prototype.valueOf = function():* {
  calls++;
  return this;
};
for (i = 0; i < 3; i++) {
  // Decimal parsing has separate rounding behavior; check the conversion hook here.
  trace(Number([coordinate]) > 200, calls);
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
trace(String([coordinate]), 1 / Number([-0]), Number([NaN]), Number([Infinity]));

// Formatting and parsing are not an identity for every Number, even with unmodified hooks.
trace("max round trip", Number([Number.MAX_VALUE]) === Number.MAX_VALUE);
trace("negative max round trip", Number([-Number.MAX_VALUE]) === -Number.MAX_VALUE);
trace("nul elements", Number(["1\x00", 2]), Number(["1\x00", null]));
trace("zero elements", Number([]), Number([null]), Number([undefined]));

Array.prototype.valueOf = function():* { return 17; };
trace("array prototype valueOf", Number([5]));
Array.prototype.valueOf = originalValueOf;

var own:Array = [5];
own.valueOf = function():* { return 19; };
trace("own valueOf", Number(own));
delete own.valueOf;
own.toString = function():String { return "23"; };
trace("own toString", Number(own));

var order:Array = [];
var value:Object = {
  valueOf: function():* { order.push("valueOf"); return this; },
  toString: function():String { order.push("toString"); return "7"; }
};
trace("number hint", Number(value), order.join(","));
order.length = 0;
trace("string hint", String(value), order.join(","));
