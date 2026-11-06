// A Vector's elements by a number typed int, uint or Number, through a
// reference typed as the Vector, which the code reads and writes in place
// where the index is below the length, converting what it writes to the
// element type: past the end, at it on a fixed Vector, by a negative or
// fractional index, a null Vector, values of other types, null and
// subclasses' instances, and the same through a reference typed *.
package {
  public interface Shape {}
}
package {
  public class Base implements Shape {
    public var n:int;
    public function Base(n:int) { this.n = n; }
    public function toString():String { return "Base" + n; }
  }
}
package {
  public class Sub extends Base {
    public function Sub(n:int) { super(n); }
    override public function toString():String { return "Sub" + n; }
  }
}
package {
  public class Other {
    public function toString():String { return "Other"; }
  }
}
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e.errorID, e); }
}

function intAt(v:Vector.<int>, i:int):int { return v[i]; }
function intAtUint(v:Vector.<int>, i:uint):int { return v[i]; }
function intAtNumber(v:Vector.<int>, i:Number):int { return v[i]; }
function intSet(v:Vector.<int>, i:int, x:int):int { v[i] = x; return v.length; }
function intSetNumber(v:Vector.<int>, i:Number, x:Number):int { v[i] = x; return v.length; }
function intSetUint(v:Vector.<int>, i:uint, x:uint):int { v[i] = x; return v.length; }
function intSetBoolean(v:Vector.<int>, i:int, x:Boolean):int { v[i] = x; return v.length; }
function intSetAny(v:Vector.<int>, i:int, x:*):int { v[i] = x; return v.length; }
function intAdd(v:Vector.<int>, i:int):int { v[i] += 1; return v[i]; }
function intLength(v:Vector.<int>):int { return v.length; }
function uintAt(v:Vector.<uint>, i:int):uint { return v[i]; }
function uintSet(v:Vector.<uint>, i:int, x:int):int { v[i] = x; return v.length; }
function uintSetNumber(v:Vector.<uint>, i:int, x:Number):int { v[i] = x; return v.length; }
function uintLength(v:Vector.<uint>):uint { return v.length; }
function numberAt(v:Vector.<Number>, i:Number):Number { return v[i]; }
function numberSet(v:Vector.<Number>, i:int, x:Number):int { v[i] = x; return v.length; }
function numberSetInt(v:Vector.<Number>, i:Number, x:int):int { v[i] = x; return v.length; }
function numberSetString(v:Vector.<Number>, i:int, x:String):int { v[i] = x; return v.length; }
function numberSetAny(v:Vector.<Number>, i:int, x:*):int { v[i] = x; return v.length; }
function numberLength(v:Vector.<Number>):int { return v.length; }
function baseAt(v:Vector.<Base>, i:int):Base { return v[i]; }
function baseSet(v:Vector.<Base>, i:int, x:Base):int { v[i] = x; return v.length; }
function baseSetSub(v:Vector.<Base>, i:int, x:Sub):int { v[i] = x; return v.length; }
function baseSetNull(v:Vector.<Base>, i:int):int { v[i] = null; return v.length; }
function baseSetObject(v:Vector.<Base>, i:int, x:Object):int { v[i] = x; return v.length; }
function baseSetAny(v:Vector.<Base>, i:int, x:*):int { v[i] = x; return v.length; }
function baseSetOther(v:Vector.<Base>, i:int, x:Other):int { v[i] = x; return v.length; }
function baseLength(v:Vector.<Base>):int { return v.length; }
function shapeSet(v:Vector.<Shape>, i:int, x:Sub):int { v[i] = x; return v.length; }
function shapeSetAny(v:Vector.<Shape>, i:int, x:*):int { v[i] = x; return v.length; }
function stringSet(v:Vector.<String>, i:int, x:String):int { v[i] = x; return v.length; }
function stringSetInt(v:Vector.<String>, i:int, x:int):int { v[i] = x; return v.length; }
function stringSetBase(v:Vector.<String>, i:int, x:Base):int { v[i] = x; return v.length; }
function stringAt(v:Vector.<String>, i:int):String { return v[i]; }
function objectSet(v:Vector.<Object>, i:int, x:*):int { v[i] = x; return v.length; }
function objectSetInt(v:Vector.<Object>, i:int, x:int):int { v[i] = x; return v.length; }
function objectAt(v:Vector.<Object>, i:int):* { return v[i]; }
function anyVectorAt(v:Vector.<*>, i:int):* { return v[i]; }
function anyVectorSet(v:Vector.<*>, i:int, x:int):int { v[i] = x; return v.length; }
function anyVectorLength(v:Vector.<*>):int { return v.length; }
function untypedAt(v:*, i:int):* { return v[i]; }
function untypedSet(v:*, i:Number, x:*):int { v[i] = x; return v.length; }

// Reads: in range, at the length, past it, negative, fractional, -0, NaN
// and the largest uint, by each type of index.
var vi:Vector.<int> = new <int>[10, 20, 30];
for (var i:int = -1; i < 5; i++) {
  probe("int at " + i, function ():* { return intAt(vi, i); });
}
probe("int at uint 2", function ():* { return intAtUint(vi, 2); });
probe("int at uint max", function ():* { return intAtUint(vi, 4294967295); });
probe("int at 1.5", function ():* { return intAtNumber(vi, 1.5); });
probe("int at -0", function ():* { return intAtNumber(vi, -0); });
probe("int at -1.0", function ():* { return intAtNumber(vi, -1); });
probe("int at NaN", function ():* { return intAtNumber(vi, NaN); });
probe("int at 2.0", function ():* { return intAtNumber(vi, 2); });
probe("int length", function ():* { return intLength(vi); });

// Writes: in range, at the length of a growable and of a fixed Vector,
// past it, negative and fractional.
var gi:Vector.<int> = new <int>[1, 2];
probe("int set 1", function ():* { return intSet(gi, 1, 5) + " " + gi; });
probe("int set at length", function ():* { return intSet(gi, 2, 6) + " " + gi; });
probe("int set past length", function ():* { return intSet(gi, 4, 7) + " " + gi; });
probe("int set -1", function ():* { return intSet(gi, -1, 8) + " " + gi; });
probe("int set 1.5", function ():* { return intSetNumber(gi, 1.5, 9) + " " + gi; });
probe("int set -0", function ():* { return intSetNumber(gi, -0, 9) + " " + gi; });
probe("int set uint max", function ():* { return intSetUint(gi, 4294967295, 9) + " " + gi; });
var fi:Vector.<int> = new Vector.<int>(2, true);
probe("fixed set 1", function ():* { return intSet(fi, 1, 5) + " " + fi; });
probe("fixed set at length", function ():* { return intSet(fi, 2, 6) + " " + fi; });
probe("fixed set past length", function ():* { return intSet(fi, 3, 6) + " " + fi; });
probe("fixed add", function ():* { return intAdd(fi, 1) + " " + fi; });
probe("fixed add at length", function ():* { return intAdd(fi, 2) + " " + fi; });
fi.fixed = false;
probe("unfixed set at length", function ():* { return intSet(fi, 2, 6) + " " + fi; });

// Values of other types converted to the element type.
var ci:Vector.<int> = new <int>[0, 0, 0, 0, 0, 0];
intSetNumber(ci, 0, 3.7);
intSetNumber(ci, 1, -2.5);
intSetNumber(ci, 2, 4294967296 + 5);
intSetUint(ci, 3, 4294967295);
intSetBoolean(ci, 4, true);
intSetAny(ci, 5, "12");
trace("int converted", ci);
probe("int set NaN", function ():* { return intSetNumber(ci, 0, NaN) + " " + ci; });
var vu:Vector.<uint> = new <uint>[0, 0, 0];
uintSet(vu, 0, -1);
uintSetNumber(vu, 1, -1.5);
uintSetNumber(vu, 2, 4294967296 + 7.9);
trace("uint converted", vu, uintAt(vu, 0), uintLength(vu));
probe("uint at 3", function ():* { return uintAt(vu, 3); });
probe("uint set at length", function ():* { return uintSet(vu, 3, -2) + " " + vu; });
var vn:Vector.<Number> = new <Number>[0, 0, 0, 0];
numberSet(vn, 0, 0.25);
numberSetInt(vn, 1.0, -7);
numberSetString(vn, 2, "1e3");
numberSetAny(vn, 3, undefined);
trace("number converted", vn, numberLength(vn));
numberSet(vn, 0, -0);
trace("number -0", 1 / numberAt(vn, 0));
probe("number at 4", function ():* { return numberAt(vn, 4); });
probe("number at 0.5", function ():* { return numberAt(vn, 0.5); });
probe("number set at length", function ():* { return numberSet(vn, 4, 1.5) + " " + vn; });
probe("number set int past length", function ():* { return numberSetInt(vn, 9, 1) + " " + vn; });
probe("number set NaN index", function ():* { return numberSetInt(vn, NaN, 1) + " " + vn; });

// A valueOf that empties the Vector: the value converts before the index is checked.
var shrinking:Object = {valueOf: function ():Number { gi.length = 0; return 42; }};
probe("int set shrinking", function ():* { return intSetAny(gi, 1, shrinking) + " " + gi; });
gi.push(1, 2, 3);
var growing:Object = {valueOf: function ():Number { vn.fixed = true; return 42; }};
probe("number set fixing", function ():* { return numberSetAny(vn, vn.length, growing) + " " + vn; });
vn.fixed = false;

// A class's instances: the class's, a subclass's, null, an Object that is
// one, an untyped value that is not, and another class's.
var vb:Vector.<Base> = new <Base>[new Base(1), new Base(2)];
probe("base set", function ():* { return baseSet(vb, 0, new Base(3)) + " " + vb; });
probe("base set sub", function ():* { return baseSetSub(vb, 1, new Sub(4)) + " " + vb; });
probe("base set null", function ():* { return baseSetNull(vb, 0) + " " + vb; });
probe("base at null", function ():* { return baseAt(vb, 0); });
probe("base set object", function ():* { return baseSetObject(vb, 0, new Sub(5)) + " " + vb; });
probe("base set undefined", function ():* { return baseSetAny(vb, 0, undefined) + " " + vb; });
probe("base set wrong", function ():* { return baseSetAny(vb, 0, "x") + " " + vb; });
probe("base set object wrong", function ():* { return baseSetObject(vb, 0, {}) + " " + vb; });
probe("base set other", function ():* { return baseSetOther(vb, 1, new Other()) + " " + vb; });
probe("base set other past length", function ():* { return baseSetOther(vb, 5, new Other()) + " " + vb; });
probe("base set sub at length", function ():* { return baseSetSub(vb, 2, new Sub(6)) + " " + vb; });
probe("base set sub past length", function ():* { return baseSetSub(vb, 4, new Sub(7)) + " " + vb; });
probe("base set null past length", function ():* { return baseSetNull(vb, 4) + " " + vb; });
probe("base at 1", function ():* { return baseAt(vb, 1).n; });
probe("base at 3", function ():* { return baseAt(vb, 3); });
probe("base length", function ():* { return baseLength(vb); });
var vsh:Vector.<Shape> = new <Shape>[null];
probe("shape set sub", function ():* { return shapeSet(vsh, 0, new Sub(8)) + " " + vsh; });
probe("shape set other", function ():* { return shapeSetAny(vsh, 0, new Other()) + " " + vsh; });

// Strings, Objects, and Vector.<*>, whose elements may be of any Vector's type.
var vs:Vector.<String> = new <String>["a", "b"];
probe("string set", function ():* { return stringSet(vs, 0, "c") + " " + vs; });
probe("string set null", function ():* { return stringSet(vs, 1, null) + " " + stringAt(vs, 1); });
probe("string set int", function ():* { return stringSetInt(vs, 1, 7) + " " + vs; });
probe("string set base", function ():* { return stringSetBase(vs, 0, new Sub(9)) + " " + vs; });
probe("string set base null", function ():* { return stringSetBase(vs, 0, null) + " " + stringAt(vs, 0); });
probe("string at 2", function ():* { return stringAt(vs, 2); });
var vo:Vector.<Object> = new <Object>[1, 2];
probe("object set undefined", function ():* { return objectSet(vo, 0, undefined) + " " + objectAt(vo, 0); });
probe("object set int", function ():* { return objectSetInt(vo, 1, 5) + " " + objectAt(vo, 1); });
probe("object set at length", function ():* { return objectSetInt(vo, 2, 6) + " " + vo; });
probe("object at 3", function ():* { return objectAt(vo, 3); });
var anyObjects:Vector.<*> = new <*>[undefined, 1];
probe("any of strings", function ():* { return anyVectorSet(vs, 0, 5) + " " + vs + " " + anyVectorLength(vs); });
probe("any of objects", function ():* { return anyVectorSet(anyObjects, 2, 5) + " " + anyObjects; });
probe("any at", function ():* { return anyVectorAt(anyObjects, 0) + " " + anyVectorAt(vb, 1); });
probe("any at past length", function ():* { return anyVectorAt(anyObjects, 3); });
probe("any of base", function ():* { return anyVectorSet(vb, 0, 5); });

// A null Vector.
var none:Vector.<int> = null;
probe("null at", function ():* { return intAt(none, 0); });
probe("null set", function ():* { return intSet(none, 0, 1); });
probe("null length", function ():* { return intLength(none); });
probe("null base at", function ():* { return baseAt(null, 0); });
probe("null base set", function ():* { return baseSet(null, 0, null); });
probe("null number set", function ():* { return numberSet(null, 0, 1); });

// Through a reference typed *.
var ui:Vector.<int> = new <int>[1, 2];
probe("untyped int at", function ():* { return untypedAt(ui, 1) + " " + untypedAt(vb, 1); });
probe("untyped int at length", function ():* { return untypedAt(ui, 2); });
probe("untyped int set", function ():* { return untypedSet(ui, 0, 2.5) + " " + ui; });
probe("untyped int set at length", function ():* { return untypedSet(ui, 2, "4") + " " + ui; });
probe("untyped int set past length", function ():* { return untypedSet(ui, 5, 1) + " " + ui; });
probe("untyped int set fraction", function ():* { return untypedSet(ui, 0.5, 1) + " " + ui; });
probe("untyped int set -1", function ():* { return untypedSet(ui, -1, 1) + " " + ui; });
probe("untyped base set", function ():* { return untypedSet(vb, 0, new Sub(10)) + " " + vb; });
probe("untyped base set wrong", function ():* { return untypedSet(vb, 0, new Other()) + " " + vb; });
probe("untyped base set null", function ():* { return untypedSet(vb, 0, null) + " " + vb; });
probe("untyped number set", function ():* { return untypedSet(vn, 0, "2.5") + " " + vn; });
