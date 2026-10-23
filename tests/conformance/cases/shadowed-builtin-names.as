// A file's own classes named as the builtins whose type tests take
// primitives: `is` and `as` against them test traits, as against any
// other class, while the builtins themselves still test values.
package {
  class Boolean {
    public function Boolean() {}
  }

  class String {}

  class Number {}

  // Named as builtins with natives of their own, which they do not get.
  class Array {
    public var v:int = 3;
  }

  class Date {
    public var w:int = 4;
  }

  var b:* = new Boolean();
  var s:* = new String();
  var n:* = new Number();
  trace(true is Boolean, true as Boolean, b is Boolean, b as Boolean == b);
  trace("x" is String, "x" as String, s is String, s is Boolean);
  trace(1 is Number, 1.5 as Number, n is Number);

  var B:Class = Boolean;
  var S:Class = String;
  var N:Class = Number;
  trace(true is B, true as B, b is B, "x" is S, s is S, 1 is N, n is N);

  // The builtins, as values, still test the values themselves.
  var bools:Class = Object(true).constructor;
  var strings:Class = Object("x").constructor;
  var numbers:Class = Object(1.5).constructor;
  trace(true is bools, b is bools, "x" is strings, s is strings, 2 is numbers, n is numbers);
  trace(true as bools, "x" as strings, 2 as numbers, b as bools, s as strings);

  var arrays:Class = Array;
  var dates:Class = Date;
  var a:* = new arrays();
  var d:* = new dates();
  trace(a.v, a is Array, [] is Array, "length" in a, d.w, d is Date, "time" in d);
}
