// `new` of a class the compiler finds in a slot, which compiled code
// constructs in place when the class only allocates and initializes: a
// class from its own static initializer and another's, slots of type Class holding other classes, functions, null
// and undefined, builtin classes that construct themselves, subclasses of
// them, an interface, wrong argument counts and types, a constructor that
// throws, and super() with each.
import flash.utils.Dictionary;

class Early {
  public static var made:String = attempt("Early from its own init", 1);

  public static function attempt(name:String, which:int):String {
    try {
      trace(name, which == 0 ? new Late() : new Early());
    } catch (e:Error) {
      trace(name, e.errorID, e);
    }

    return name;
  }
}

class Late {
  public static var self:String = Early.attempt("Early from Late's init", 1);
  public static var own:String = attempt();
  public var n:int = 7;

  public static function attempt():String {
    try {
      trace("Late from its own init", new Late());
    } catch (e:Error) {
      trace("Late from its own init", e.errorID, e);
    }

    return "";
  }
}

class Point {
  public var x:Number;
  public var y:Number;
  public function Point(x:Number, y:Number = 2) {
    this.x = x;
    this.y = y;
  }
  public function toString():String { return "(" + x + "," + y + ")"; }
}

class Point3 extends Point {
  public var z:int;
  public function Point3(x:Number, y:Number, z:int) {
    super(x, y);
    this.z = z;
  }
  override public function toString():String { return "(" + x + "," + y + "," + z + ")"; }
}

class Short extends Point {
  public function Short() { super(); }
}

class Long extends Point {
  public function Long() { super(1, 2, 3); }
}

dynamic class Bag {
  public var kept:int = 1;
}

class Thrower {
  public static var count:int = 0;
  public function Thrower(fail:Boolean) {
    count++;
    if (fail) {
      throw new Error("thrown from the constructor");
    }
  }
}

class MyError extends Error {
  public function MyError(m:String) { super(m, 99); }
}

class MyArray extends Array {
  public function MyArray(n:int) { super(n); }
}

class MyDictionary extends Dictionary {
  public function MyDictionary() { super(true); }
}

class Holder {
  public static var K:Class = Point;
  public static var F:* = null;
}

interface Thing {}

class Typed {
  public var p:Point;
  public function Typed(p:Point) { this.p = p; }
}

class Rock {}

function probe(name:String, f:Function):String {
  try {
    var r:* = f();
    trace(name, r is Object ? typeof r : r, r);
  } catch (e:Error) {
    trace(name, e.errorID, e);
  }

  return name;
}

var later:Class = Late;
probe("Late after its init", function ():* { return new Late().n; });
for (var i:int = 0; i < 3; i++) {
  probe("point " + i, function ():* { return new Point(i, i + 1); });
  probe("point default " + i, function ():* { return new Point(i); });
  probe("point too few " + i, function ():* { return new Point(); });
  probe("point too many " + i, function ():* { return new Point(1, 2, 3); });
  probe("point coerced " + i, function ():* { return new Point("4", true); });
  probe("point3 " + i, function ():* { return new Point3(1, 2, 3.5); });
  probe("super too few " + i, function ():* { return new Short(); });
  probe("super too many " + i, function ():* { return new Long(); });
  probe("bag " + i, function ():* { var b:Bag = new Bag(); b.extra = i; return b.kept + b.extra; });
  probe("thrower " + i, function ():* { return new Thrower(i == 1); });
  probe("typed " + i, function ():* { return new Typed(new Point3(1, 1, 1)).p; });
  probe("typed wrong " + i, function ():* { return new Typed(new Rock() as Point).p; });
  probe("my error " + i, function ():* { var e:MyError = new MyError("m"); return e.errorID + " " + e.message; });
  probe("my array " + i, function ():* { var a:MyArray = new MyArray(3); return a.length; });
  probe("my dictionary " + i, function ():* { return new MyDictionary() is Dictionary; });
  probe("array " + i, function ():* { return new Array(3).length; });
  probe("array elements " + i, function ():* { return new Array(1, 2, 3).join("-"); });
  probe("date " + i, function ():* { return new Date(0).time; });
  probe("dictionary " + i, function ():* { return new Dictionary() is Dictionary; });
  probe("object " + i, function ():* { return new Object() is Object; });
  probe("error " + i, function ():* { return new Error("e", 5).errorID; });
  probe("regexp " + i, function ():* { return new RegExp("a+", "g").test("caab"); });
  probe("xml " + i, function ():* { return new XML("<a><b/></a>").children().length(); });
  probe("namespace " + i, function ():* { return new Namespace("p", "u").prefix; });
  probe("string " + i, function ():* { return new String(12).length; });
  probe("int " + i, function ():* { return new int("12") + 1; });
  probe("class slot " + i, function ():* { return new Holder.K(5); });
  probe("thrower count " + i, function ():* { return Thrower.count; });
}

Holder.K = Point3;
probe("class slot point3", function ():* { return new Holder.K(1, 2, 3); });
Holder.K = Bag;
probe("class slot bag", function ():* { return new Holder.K().kept; });
Holder.K = Array;
probe("class slot array", function ():* { return new Holder.K(2).length; });
Holder.K = Thing;
probe("class slot interface", function ():* { return new Holder.K(); });
Holder.K = null;
probe("class slot null", function ():* { return new Holder.K(); });
Holder.F = function ():void { this.a = 1; };
probe("any slot function", function ():* { return new Holder.F().a; });
Holder.F = Point;
probe("any slot class", function ():* { return new Holder.F(8); });
Holder.F = undefined;
probe("any slot undefined", function ():* { return new Holder.F(); });
Holder.F = 3;
probe("any slot number", function ():* { return new Holder.F(); });
probe("late variable", function ():* { return new later().n; });
