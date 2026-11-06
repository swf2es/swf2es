// Methods of the base called through super, as the compiler binds them:
// over overrides two and three deep, a base's method a subclass does not
// override, arguments that do not coerce, null and undefined, defaults,
// a rest parameter, a native base's method given an argument to convert,
// a method that sets the default XML namespace, recursion, one that
// throws, and names super finds no method for: a slot holding a function,
// an accessor, and Object's prototype methods.
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
  public class Base {
    public var fn:Function = function (s:String):String { return "fn " + s; };
    public function feed(a:Animal, times:int = 1):String { return "base " + a + "x" + times; }
    public function many(a:Animal, ...rest):String { return "many " + a + " " + rest.length; }
    public function plain(n:Number):Number { return n * 2; }
    public function fail(a:Animal):String {
      if (a == null) {
        throw new Error("no animal");
      }

      return "fine " + a;
    }
    public function xml(a:Animal):String {
      default xml namespace = "urn:b";
      var x:XML = <a/>;
      return a + " " + x.name();
    }
    public function down(a:Animal, n:int):int { return n; }
    public function get value():String { return "value"; }
  }
}
package {
  public class Middle extends Base {
    override public function feed(a:Animal, times:int = 1):String { return "middle " + super.feed(a, times + 1); }
    override public function many(a:Animal, ...rest):String { return "middle " + super.many(a, 1, 2) + " " + rest.length; }
    override public function down(a:Animal, n:int):int { return n <= 0 ? 0 : 1 + super.down(a, n - 1) + down(a, n - 1); }
  }
}
package {
  public class Leaf extends Middle {
    override public function feed(a:Animal, times:int = 1):String { return "leaf " + super.feed(a, times); }
    public function feedOnce(a:Animal):String { return super.feed(a); }
    public function feedAny(a:*):String { return super.feed(a, 2); }
    public function feedUntyped(a:*, n:*):String { return super.feed(a, n); }
    public function manyNone(a:*):String { return super.many(a); }
    public function plainOf(v:*):Number { return super.plain(v); }
    public function failOf(a:Animal):String { return super.fail(a); }
    public function xmlOf(a:Animal):String { return super.xml(a); }
    public function fnOf(s:String):String { return super.fn(s); }
    public function valueOf2():* { return super.value; }
    public function stringOf():String { return super.toString(); }
  }
}
package {
  import flash.utils.ByteArray;

  public class Bytes extends ByteArray {
    override public function writeByte(value:int):void { super.writeByte(value + 1); }
    public function writeAny(v:*):void { super.writeByte(v); }
    public function writeAll(b:ByteArray):void { super.writeBytes(b, 1); }
  }
}
class Rock {}

function probe(name:String, f:Function):void {
  try {
    trace(name, f());
  } catch (e:Error) {
    trace(name, e.errorID, e);
  }
}

var leaf:Leaf = new Leaf();
var rock:* = new Rock();
var nothing:* = undefined;
for (var i:int = 0; i < 3; i++) {
  probe("chain " + i, function ():* { return leaf.feed(new Dog(), i); });
  probe("chain null " + i, function ():* { return leaf.feed(null); });
  probe("once " + i, function ():* { return leaf.feedOnce(new Animal("cat")); });
  probe("any " + i, function ():* { return leaf.feedAny(new Dog()); });
  probe("any wrong " + i, function ():* { return leaf.feedAny(rock); });
  probe("any undefined " + i, function ():* { return leaf.feedAny(nothing); });
  probe("untyped count " + i, function ():* { return leaf.feedUntyped(new Dog(), "3"); });
  probe("untyped count wrong " + i, function ():* { return leaf.feedUntyped(new Dog(), rock); });
  probe("rest " + i, function ():* { return leaf.many(new Dog(), 1, 2, 3); });
  probe("rest none " + i, function ():* { return leaf.manyNone(new Dog()); });
  probe("rest wrong " + i, function ():* { return leaf.manyNone(rock); });
  probe("plain " + i, function ():* { return leaf.plainOf("21"); });
  probe("plain object " + i, function ():* { return leaf.plainOf({valueOf: function ():* { return 4; }}); });
  probe("fail " + i, function ():* { return leaf.failOf(new Dog()); });
  probe("fail throws " + i, function ():* { return leaf.failOf(null); });
  probe("xml " + i, function ():* { return leaf.xmlOf(new Dog()); });
  probe("down " + i, function ():* { return leaf.down(new Dog(), 6); });
  probe("slot " + i, function ():* { return leaf.fnOf("s"); });
  probe("getter " + i, function ():* { return leaf.valueOf2(); });
  probe("prototype " + i, function ():* { return leaf.stringOf(); });
  probe("native " + i, function ():* {
    var b:Bytes = new Bytes();
    b.writeByte(1);
    b.writeAny("7");
    b.writeAny(2.9);
    b.writeAll(b);
    b.position = 0;
    return b.length + " " + b.readByte() + " " + b.readByte() + " " + b.readByte() + " " + b.readByte();
  });
  probe("native null " + i, function ():* { var b:Bytes = new Bytes(); b.writeAll(null); return b.length; });
}
