// Constructors with class-typed parameters, whose arguments `new` of a
// known class and super() coerce before the call: the class's own
// instances, a subclass's, null, undefined, values of another class, and
// untyped values; numbers and strings converted beside them, a
// conversion seen (one to a call: avmshell's JIT converts a call's
// arguments last to first, its interpreter first to last, and swf2es
// first to last); defaults; counts the constructor does not take;
// the same classes constructed through untyped and Class-typed values;
// subclasses of classes that construct themselves; a constructor that
// sets the default XML namespace; and one that throws.
package {
  public class Animal {
    public var name:String;
    public function Animal(name:String = "animal") { this.name = name; }
    public function toString():String { return name; }
  }
}
package {
  public class Dog extends Animal {
    public function Dog() { super("dog"); }
  }
}
package {
  public class Pen {
    public var a:Animal;
    public var b:Animal;
    public var n:int;
    public var label:String;
    public function Pen(a:Animal, n:int, b:Animal = null, label:String = "pen") {
      this.a = a;
      this.n = n;
      this.b = b;
      this.label = label;
    }
    public function toString():String { return label + "[" + a + "," + n + "," + b + "]"; }
  }
}
package {
  public class BigPen extends Pen {
    public function BigPen(a:Animal, b:*) { super(a, 9, b, "big"); }
  }
}
package {
  public class XmlPen {
    public var text:String;
    public function XmlPen(a:Animal) {
      default xml namespace = "urn:pen";
      var x:XML = <p/>;
      text = a + " " + x.name();
    }
  }
}
package {
  public class Picky {
    public function Picky(a:Animal) {
      if (a == null) {
        throw new Error("no animal");
      }
    }
  }
}
package {
  public class AnimalError extends Error {
    public var who:Animal;
    public function AnimalError(who:Animal) {
      super("error " + who, 7);
      this.who = who;
    }
  }
}
package {
  public class Herd extends Array {
    public function Herd(lead:Animal) {
      super();
      push(lead);
    }
  }
}
class Rock {}

class Holder {
  public static var K:Class = Pen;
}

function probe(name:String, f:Function):void {
  try {
    trace(name, f());
  } catch (e:Error) {
    trace(name, e.errorID, e);
  }
}

function seen(name:String, v:*):Object {
  return {
    valueOf: function ():* { trace("valueOf", name); return v; },
    toString: function ():String { trace("toString", name); return String(v); }
  };
}

var rock:* = new Rock();
var nothing:* = undefined;
var dog:* = new Dog();
for (var i:int = 0; i < 3; i++) {
  probe("pen " + i, function ():* { return new Pen(new Animal("cat"), i); });
  probe("pen subclass " + i, function ():* { return new Pen(new Dog(), 2, new Dog(), "dogs"); });
  probe("pen null " + i, function ():* { return new Pen(null, 3, null); });
  probe("pen undefined " + i, function ():* { return new Pen(nothing, 4, nothing); });
  probe("pen untyped " + i, function ():* { return new Pen(dog, "5", dog, 6); });
  probe("pen wrong " + i, function ():* { return new Pen(rock, 1); });
  probe("pen wrong second " + i, function ():* { return new Pen(dog, 1, rock); });
  probe("pen seen " + i, function ():* { return new Pen(dog, seen("n", 8)); });
  probe("pen seen label " + i, function ():* { return new Pen(dog, 2, null, seen("label", "seen")); });
  probe("pen too few " + i, function ():* { var c:* = Pen; return new c(dog); });
  probe("pen too many " + i, function ():* { var c:* = Pen; return new c(dog, 1, dog, "x", 5); });
  probe("pen untyped class " + i, function ():* { var c:* = Pen; return new c(dog, "2"); });
  probe("pen untyped class wrong " + i, function ():* { var c:* = Pen; return new c(rock, 2); });
  probe("pen class slot " + i, function ():* { return new Holder.K(dog, 3); });
  probe("pen class slot wrong " + i, function ():* { return new Holder.K(rock, 3); });
  probe("big " + i, function ():* { return new BigPen(new Dog(), new Animal()); });
  probe("big wrong " + i, function ():* { return new BigPen(new Dog(), rock); });
  probe("big null " + i, function ():* { return new BigPen(null, nothing); });
  probe("xml " + i, function ():* { return new XmlPen(new Dog()).text; });
  probe("picky " + i, function ():* { return new Picky(new Dog()) is Picky; });
  probe("picky throws " + i, function ():* { return new Picky(null); });
  probe("error " + i, function ():* { var e:AnimalError = new AnimalError(new Dog()); return e.errorID + " " + e.message + " " + e.who; });
  probe("error wrong " + i, function ():* { return new AnimalError(rock); });
  probe("herd " + i, function ():* { var h:Herd = new Herd(new Dog()); return h.length + " " + h[0]; });
  probe("herd wrong " + i, function ():* { return new Herd(rock); });
}
