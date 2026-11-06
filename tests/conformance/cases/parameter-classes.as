// Parameters typed as a class, coerced on entry: the class's own instances,
// a subclass's, an implementing class's for an interface, null and
// undefined, a Vector's, values of other types, and the first call made
// with each of these before any instance, through a bound call, an
// untyped one, a closure and apply.
package {
  public interface Named {
    function get name():String;
  }
}
package {
  public class Animal implements Named {
    public function get name():String { return "animal"; }
    public function toString():String { return "[" + name + "]"; }
  }
}
package {
  public class Dog extends Animal {
    override public function get name():String { return "dog"; }
  }
}
package {
  public class Rock {
    public function get name():String { return "rock"; }
  }
}
package {
  public class Keeper {
    public function feed(a:Animal):String { return a == null ? "nobody" : a.name; }
    public function call(n:Named):String { return n == null ? "nobody" : n.name; }
    public function count(v:Vector.<Animal>):int { return v == null ? -1 : v.length; }
    public function pair(a:Animal, b:Dog):String { return String(a) + String(b); }
  }
}
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e.errorID, e); }
}
function firstNull(a:Animal):String { return String(a); }
function firstWrong(a:Animal):String { return String(a); }
function firstSub(a:Animal):String { return String(a); }

// Before any call with an instance of the class: null, a wrong value, a subclass's.
probe("first null", function ():* { return firstNull(null); });
probe("then animal", function ():* { return firstNull(new Animal()); });
probe("first wrong", function ():* { return firstWrong(new Rock() as Animal); });
var untypedFirst:Function = firstWrong;
probe("first wrong untyped", function ():* { return untypedFirst(new Rock()); });
probe("then animal", function ():* { return firstWrong(new Animal()); });
probe("first sub", function ():* { return firstSub(new Dog()); });
probe("then animal", function ():* { return firstSub(new Animal()); });

var k:Keeper = new Keeper();
var u:* = k;
for (var i:int = 0; i < 3; i++) {
  probe("animal " + i, function ():* { return k.feed(new Animal()); });
  probe("dog " + i, function ():* { return k.feed(new Dog()); });
  probe("null " + i, function ():* { return k.feed(null); });
  probe("untyped undefined " + i, function ():* { return u.feed(undefined); });
  probe("untyped rock " + i, function ():* { return u.feed(new Rock()); });
  probe("untyped string " + i, function ():* { return u.feed("animal"); });
  probe("untyped object " + i, function ():* { return u.feed({name: "x"}); });
  probe("interface animal " + i, function ():* { return k.call(new Animal()); });
  probe("interface dog " + i, function ():* { return k.call(new Dog()); });
  probe("interface rock " + i, function ():* { return u.call(new Rock()); });
  probe("vector " + i, function ():* { return k.count(new <Animal>[new Dog()]); });
  probe("vector of dogs " + i, function ():* { return u.count(new <Dog>[new Dog()]); });
  probe("vector null " + i, function ():* { return k.count(null); });
  probe("vector array " + i, function ():* { return u.count([new Animal()]); });
  probe("pair " + i, function ():* { return k.pair(new Dog(), new Dog()); });
  probe("pair wrong second " + i, function ():* { return u.pair(new Dog(), new Animal()); });
  probe("pair wrong first " + i, function ():* { return u.pair(new Rock(), new Animal()); });
}

var feed:Function = k.feed;
probe("closure", function ():* { return feed(new Dog()); });
probe("closure wrong", function ():* { return feed(1); });
probe("apply", function ():* { return feed.apply(null, [new Animal()]); });
probe("apply undefined", function ():* { return feed.apply(null, [undefined]); });
probe("call wrong", function ():* { return feed.call(null, new Rock()); });
