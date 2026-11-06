// Methods with parameters typed as classes, called through every path:
// calls the compiler binds, whose arguments it has coerced already, and
// those it does not, through *, a closure, apply and call, an interface,
// super, a setter and a property set, which must still count and coerce
// them as the method's entry does. Optional parameters with and without
// arguments, overrides called through the base's type, statics, a
// script's functions, and a method that sets the default XML namespace.
package {
  public interface Feeder {
    function feed(a:Animal, times:int = 1):String;
  }
}
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
  public class Keeper implements Feeder {
    public var last:Animal;
    public function feed(a:Animal, times:int = 1):String { return a + "x" + times; }
    public function pair(a:Animal, b:Dog, label:String = "pair", o:Object = null):String {
      return label + ":" + a + "," + b + "," + o;
    }
    public function set pet(a:Animal):void { last = a; }
    public function get pet():Animal { return last; }
    public static function adopt(a:Animal, n:Number = 2):String { return "adopt " + a + " " + n; }
    public function chain(a:Animal, depth:int):int { return depth == 0 ? 0 : 1 + chain(a, depth - 1); }
    public function xmlName(a:Animal, x:XML):String {
      default xml namespace = "urn:k";
      return a + " " + x.name();
    }
  }
}
package {
  public class Picky extends Keeper {
    override public function feed(a:Animal, times:int = 1):String {
      return "picky " + super.feed(a, times + 1);
    }
  }
}
class Rock {}

function walk(a:Animal, n:int):String { return "walk " + a + " " + n; }

function probe(name:String, f:Function):void {
  try {
    trace(name, f());
  } catch (e:Error) {
    trace(name, e.errorID, e);
  }
}

var k:Keeper = new Keeper();
var p:Keeper = new Picky();
var u:* = k;
var up:* = p;
var feeder:Feeder = p;
var rock:* = new Rock();
var nothing:* = undefined;
var text:* = "dog";
for (var i:int = 0; i < 3; i++) {
  probe("bound " + i, function ():* { return k.feed(new Dog()); });
  probe("bound times " + i, function ():* { return k.feed(new Animal(), i); });
  probe("bound null " + i, function ():* { return k.feed(null, 3); });
  probe("bound undefined " + i, function ():* { return k.feed(nothing); });
  probe("bound coerced wrong " + i, function ():* { return k.feed(rock); });
  probe("override " + i, function ():* { return p.feed(new Dog()); });
  probe("override wrong " + i, function ():* { return p.feed(rock, 2); });
  probe("untyped " + i, function ():* { return u.feed(new Dog()); });
  probe("untyped wrong " + i, function ():* { return u.feed(rock); });
  probe("untyped string " + i, function ():* { return u.feed("dog"); });
  probe("untyped too few " + i, function ():* { return u.feed(); });
  probe("untyped too many " + i, function ():* { return u.feed(new Dog(), 1, 2); });
  probe("untyped times " + i, function ():* { return u.feed(new Dog(), "4"); });
  probe("untyped override wrong " + i, function ():* { return up.feed(rock); });
  probe("interface " + i, function ():* { return feeder.feed(new Dog(), 5); });
  probe("interface wrong " + i, function ():* { return feeder.feed(rock); });
  probe("closure " + i, function ():* { var f:Function = k.feed; return f(new Dog()); });
  probe("closure wrong " + i, function ():* { var f:Function = k.feed; return f(rock); });
  probe("closure too many " + i, function ():* { var f:Function = k.feed; return f(null, 1, 2); });
  probe("apply " + i, function ():* { return k.feed.apply(null, [new Dog(), 2]); });
  probe("apply wrong " + i, function ():* { return k.feed.apply(null, [{}]); });
  probe("call wrong " + i, function ():* { return k.feed.call(null, 5); });
  probe("pair " + i, function ():* { return k.pair(new Dog(), new Dog()); });
  probe("pair label " + i, function ():* { return k.pair(new Animal(), null, "two", nothing); });
  probe("pair untyped " + i, function ():* { return u.pair(new Dog(), new Dog(), 7, nothing); });
  probe("pair untyped wrong " + i, function ():* { return u.pair(new Dog(), new Animal()); });
  probe("setter " + i, function ():* { k.pet = new Dog(); return k.pet; });
  probe("setter untyped " + i, function ():* { u.pet = new Animal(); return u.pet; });
  probe("setter untyped wrong " + i, function ():* { u.pet = rock; return u.pet; });
  probe("setter untyped string " + i, function ():* { u.pet = text; return u.pet; });
  probe("static " + i, function ():* { return Keeper.adopt(new Dog()); });
  probe("static untyped " + i, function ():* { var c:* = Keeper; return c.adopt(new Dog(), "3"); });
  probe("static untyped wrong " + i, function ():* { var c:* = Keeper; return c.adopt(rock); });
  probe("script " + i, function ():* { return walk(new Dog(), i); });
  probe("script closure wrong " + i, function ():* { var f:Function = walk; return f(rock, 1); });
  probe("recursion " + i, function ():* { return k.chain(new Dog(), 50); });
  probe("xml " + i, function ():* { return k.xmlName(new Dog(), <a xmlns="urn:x"/>); });
  probe("xml untyped " + i, function ():* { return u.xmlName(new Dog(), "<b/>"); });
  probe("xml untyped wrong " + i, function ():* { return u.xmlName(rock, <c/>); });
}
