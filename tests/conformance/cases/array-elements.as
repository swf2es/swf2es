// An Array's elements by a number typed int, uint or Number, which the
// code reads and writes in place where the element is there: a hole, null,
// undefined, a number that is no index and a write past the length are
// found as any other name is, through the prototype and dynamic properties.
package {
  public dynamic class Counted extends Array {
    override public function get length():uint { return 2; }
  }
}
package {
  public class Sealed extends Array {}
}
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e); }
}
function getInt(a:Array, i:int):* { return a[i]; }
function getUint(a:Array, i:uint):* { return a[i]; }
function getNumber(a:Array, i:Number):* { return a[i]; }
function setInt(a:Array, i:int, v:*):void { a[i] = v; }
function setUint(a:Array, i:uint, v:*):void { a[i] = v; }
function setNumber(a:Array, i:Number, v:*):void { a[i] = v; }
function keys(o:*):String {
  var names:Array = [];
  for (var k:* in o) { names.push(k); }
  names.sort();
  return names.join(",");
}

// Present elements, and those that are not: holes and past the end.
var a:Array = [10, null, undefined, "s"];
a[6] = 60;
for (var i:int = -1; i < 8; i++) {
  trace("int", i, getInt(a, i), getUint(a, uint(i)), getNumber(a, i));
}
trace(a.length, keys(a));

// Holes, null and undefined beside elements of Array.prototype.
Array.prototype[1] = "p1";
Array.prototype[2] = "p2";
Array.prototype[4] = "p4";
Array.prototype[9] = "p9";
trace("proto", getInt(a, 1), getInt(a, 2), getInt(a, 4), getInt(a, 5), getInt(a, 9));
trace("proto", getUint(a, 4), getNumber(a, 4), getNumber(a, 9), a.length);
delete a[0];
trace("deleted", getInt(a, 0), getUint(a, 0), getNumber(a, 0), 0 in a);
Array.prototype[0] = "p0";
trace("deleted", getInt(a, 0), a.hasOwnProperty(0));
delete Array.prototype[0];
delete Array.prototype[1];
delete Array.prototype[2];
delete Array.prototype[4];
delete Array.prototype[9];

// Numbers that are no index, and the largest uint, which is not one either.
var b:Array = [1, 2, 3];
setNumber(b, 1.5, "half");
setNumber(b, -1, "minus");
setInt(b, -2, "int minus");
setNumber(b, NaN, "nan");
setNumber(b, -0, "zero");
setUint(b, 4294967295, "max");
setNumber(b, 4294967296, "past");
trace(b.length, keys(b));
trace(getNumber(b, 1.5), getNumber(b, -1), getInt(b, -2), getNumber(b, NaN), getInt(b, 0));
trace(getUint(b, 4294967295), getNumber(b, 4294967295), getNumber(b, 4294967296), b["4294967295"]);
setUint(b, 4294967294, "last");
trace(b.length, getUint(b, 4294967294), getNumber(b, 4294967294), getInt(b, -2));
trace(getNumber(b, 1e21), getNumber(b, Infinity), getNumber(b, -Infinity));

// Names that are strings of numbers.
var c:Array = ["x", "y"];
c["1"] = "Y";
c["01"] = "zero one";
c["2"] = "Z";
trace(c.length, c[1], c["01"], getInt(c, 2), getNumber(c, 1), keys(c));

// Writes that grow the array, below and past its length, and over holes.
var d:Array = [];
for (var j:uint = 0; j < 4; j++) {
  setUint(d, j, j * 2);
}
setInt(d, d.length, "end");
setNumber(d, 10, "far");
setInt(d, 7, "hole");
trace(d.length, d.join("|"));
d.length = 3;
setInt(d, 1, "kept");
trace(d.length, d.join("|"), getInt(d, 4), getInt(d, 10));

// A subclass whose length getter is overridden still has its elements.
var e:Counted = new Counted();
e.push(1, 2, 3, 4);
setInt(e, 3, "four");
setInt(e, 5, "six");
trace(e.length, getInt(e, 0), getInt(e, 3), getInt(e, 4), getInt(e, 5), getUint(e, 3));
var ee:Array = e;
ee[1] = "two";
trace(ee[1], ee[3], keys(e));

// A subclass that is not dynamic has no elements from SWF 13.
var s:Sealed = new Sealed();
probe("sealed get", function():* { return getInt(s, 0); });
probe("sealed set", function():* { setInt(s, 0, 1); return s.length; });
probe("sealed set uint", function():* { setUint(s, 0, 1); return s.length; });

// A null Array fails before its index is looked at.
var n:Array = null;
probe("null get", function():* { return getInt(n, 0); });
probe("null get minus", function():* { return getInt(n, -1); });
probe("null set", function():* { setInt(n, 0, 1); });
probe("null set minus", function():* { setInt(n, -1, 1); });
probe("null set fraction", function():* { setNumber(n, 0.5, 1); });
var u:Array;
probe("undefined get", function():* { return getUint(u, 0); });

// Element values of every kind read back as written.
var f:Array = [];
var values:Array = [0, -0, 1.5, NaN, "", "0", true, false, null, undefined, f, int.MAX_VALUE];
for (var k:int = 0; k < values.length; k++) {
  setInt(f, k, values[k]);
}
var out:Array = [];
for (k = 0; k < values.length; k++) {
  var v:* = getInt(f, k);
  out.push(v === values[k] || (v != v && values[k] != values[k]) ? "same" : "differs");
}
trace(out.join(" "), 1 / getInt(f, 1));

// The element read in place and the one read by name agree, the array
// changing between.
var g:Array = [1, 2, 3];
var sum:Number = 0;
for (var r:int = 0; r < 6; r++) {
  sum += Number(getInt(g, r % 4));
  if (r == 2) {
    g.length = 1;
  }

  if (r == 4) {
    g[3] = 30;
  }
}
trace(sum, g.length, g);
