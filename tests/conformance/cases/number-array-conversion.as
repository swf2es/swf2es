// Number(array): valueOf returns the Array, whose toString joins its
// elements with commas, which then read back as a number. The runtime skips
// the formatting for an Array whose conversion is still the builtins'; each
// result here must be the one the join and the read give.
package {
  dynamic class Sub extends Array {
    public function Sub(... rest) {
      for (var i:int = 0; i < rest.length; i++) {
        this[i] = rest[i];
      }
    }
  }

  function show(label:String, a:*):void {
    var n:Number = Number(a);
    // 1 / n tells -0 from 0.
    trace(label, n, n === 0 ? 1 / n : "", -a, +a);
  }

  show("empty", []);
  show("int", [7]);
  show("negative int", [-7]);
  show("int max", [int.MAX_VALUE]);
  show("uint max", [uint.MAX_VALUE]);
  show("fraction", [0.1 + 0.2]);
  // avmplus reads 209.14077758789063 back as ...065, a decimal read the runtime leaves to JavaScript.
  trace("coordinate", Math.abs(Number([209.14077758789063]) - 209.14077758789063) < 1e-12);
  show("negative zero", [-0]);
  show("zero", [0]);
  show("NaN", [NaN]);
  show("Infinity", [Infinity]);
  show("-Infinity", [-Infinity]);
  show("MIN_VALUE", [Number.MIN_VALUE]);
  show("subnormal", [2.2250738585072009e-308]);
  show("smallest normal", [2.2250738585072014e-308]);
  show("tiny", [1.2345678901234567e-10]);
  show("below 1e21", [999999999999999900000]);
  show("1e21", [1e21]);
  show("past 1e21", [1.0000000000000001e21]);
  show("large", [1.2345678901234567e21]);
  show("MAX_VALUE", [Number.MAX_VALUE]);
  show("-MAX_VALUE", [-Number.MAX_VALUE]);
  trace("MAX_VALUE round trip", Number([Number.MAX_VALUE]) === Number.MAX_VALUE);
  trace("1e21 neighbour round trip", Number([1.0000000000000001e21]) === 1.0000000000000001e21);

  show("null", [null]);
  show("undefined", [undefined]);
  show("true", [true]);
  show("false", [false]);
  show("empty string", [""]);
  show("spaces", ["  12  "]);
  show("tabs and newlines", ["\t\n12\r\n"]);
  show("hex", ["0x1F"]);
  show("signed hex", ["-0x1F"]);
  show("octal", ["0o17"]);
  show("binary", ["0b101"]);
  show("exponent", ["1.5e3"]);
  show("bare exponent", ["4e"]);
  show("bare signed exponent", ["4e+"]);
  show("Infinity string", ["Infinity"]);
  show("word", ["abc"]);
  show("nul", ["12\x003"]);
  show("leading nul", ["\x0012"]);
  show("negative zero string", ["-0"]);

  show("two numbers", [1, 2]);
  show("two empty strings", ["", ""]);
  show("two nulls", [null, null]);
  show("two undefined", [undefined, undefined]);
  show("null and number", [null, 5]);
  show("number and null", [5, null]);
  show("booleans", [true, false]);
  show("nul elements", ["1\x00", 2]);
  show("nul second", [1, "2\x00"]);
  show("signed hex pair", ["-0x1", 2]);

  // Holes: the element comes from the prototypes.
  var sparse:Array = [];
  sparse.length = 1;
  show("hole", sparse);
  var sparse2:Array = [];
  sparse2[1] = 5;
  show("leading hole", sparse2);
  Array.prototype[0] = 42;
  show("hole with prototype element", sparse);
  show("leading hole with prototype element", sparse2);
  show("own element over prototype", [3]);
  delete Array.prototype[0];
  Object.prototype[0] = 43;
  show("hole with Object.prototype element", sparse);
  delete Object.prototype[0];
  show("hole again", sparse);

  // Objects as elements convert through their own hooks.
  show("nested", [[5]]);
  show("nested empty", [[]]);
  show("object", [{valueOf: function():* { return 9; }, toString: function():String { return "10"; }}]);
  show("date", [new Date(0)]);

  // Hooks: the prototype's and the Array's own.
  var originalToString:Function = Array.prototype.toString;
  Array.prototype.toString = function():String { return "77"; };
  show("patched Array.prototype.toString", [5]);
  show("patched toString, empty", []);
  Array.prototype.toString = originalToString;
  show("restored toString", [5]);

  var originalJoin:Function = Array.prototype.join;
  Array.prototype.join = function(sep:* = undefined):String { return "88"; };
  show("patched Array.prototype.join", [5]);
  Array.prototype.join = originalJoin;

  Array.prototype.valueOf = function():* { return 66; };
  show("Array.prototype.valueOf", [5]);
  delete Array.prototype.valueOf;
  show("deleted Array.prototype.valueOf", [5]);

  var originalValueOf:Function = Object.prototype.valueOf;
  Object.prototype.valueOf = function():* { return 55; };
  show("patched Object.prototype.valueOf", [5]);
  Object.prototype.valueOf = originalValueOf;
  show("restored valueOf", [5]);

  var ownToString:Array = [5];
  ownToString.toString = function():String { return "44"; };
  show("own toString", ownToString);
  var ownValueOf:Array = [5];
  ownValueOf.valueOf = function():* { return 33; };
  show("own valueOf", ownValueOf);
  var ownJoin:Array = [5];
  ownJoin.join = function(sep:* = undefined):String { return "22"; };
  show("own join", ownJoin);

  show("subclass", new Sub(5));
  show("subclass empty", new Sub());
  Sub.prototype.toString = function():String { return "11"; };
  show("subclass toString", new Sub(5));

  // int and uint conversions of an Array go the same way.
  var ints:Array = [3.7];
  trace("int", int(ints), uint(ints), int([-3.7]), uint([-1]), int(["0x10"]), int([1, 2]));
  var x:* = [2.5];
  x++;
  trace("increment", x);
  var y:* = [2.5];
  trace("negate", -y, y - 1, y * 2, y / 2, y % 2);

  // Many conversions of one coordinate, as a 3D renderer makes them.
  var sum:Number = 0;
  var coordinate:Number = 209.14077758789063;
  for (var k:int = 0; k < 1000; k++) {
    sum += Number([coordinate]) + Number([-coordinate]) + Number([k / 7]);
  }
  trace("sum", Math.round(sum * 1000) / 1000);
}
