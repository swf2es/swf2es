// lastIndexOf from a negative index before the start searches from 0, as
// ClampIndexInt clamps it: the first element still matches.
var a:Array = [5, "5", 3, false, 4, 5, undefined, 9];
trace(a.lastIndexOf(5), a.lastIndexOf(5, 1), a.lastIndexOf(5, -1), a.lastIndexOf(5, -3));
trace(a.lastIndexOf(5, -8), a.lastIndexOf(5, -9), a.lastIndexOf(5, -100));
trace(a.lastIndexOf("5", -8), a.lastIndexOf("5", -9), a.lastIndexOf(9, -100));
trace(a.lastIndexOf(5, 100), a.lastIndexOf(undefined), a.lastIndexOf(5, NaN));
var o:Object = {length: 3, 0: "x", 1: "y", 2: "x"};
trace(Array.prototype.lastIndexOf.call(o, "x", -10), Array.prototype.lastIndexOf.call(o, "x", -1));
