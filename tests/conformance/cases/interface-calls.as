// Methods called through an interface, which the receiver's class may
// place at another dispatch id than the interface's: implementations in
// the class, overridden in a subclass, inherited from a base that does
// not name the interface, laid out after other methods, and a native's
// (ByteArray's IDataInput). A subinterface's call of its base's method,
// one method implementing two interfaces' of the same name, receivers of
// several classes at one site, null receivers, arguments that do not
// coerce, defaults, a rest parameter given more arguments than it names,
// a method that sets the default XML namespace, and one that throws.
package {
  public interface Feeder {
    function feed(a:Animal, times:int = 1):String;
    function count():int;
  }
}
package {
  public interface Talker extends Feeder {
    function talk(s:String):String;
  }
}
package {
  public interface Named {
    function count():int;
  }
}
package {
  public interface Many {
    function many(a:Animal, ...rest):String;
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
  public class Keeper implements Feeder, Named, Many {
    public var n:int;
    public function count():int { return ++n; }
    public function feed(a:Animal, times:int = 1):String { return "keeper " + a + "x" + times; }
    public function many(a:Animal, ...rest):String { return "many " + a + " " + rest.length; }
  }
}
package {
  public class Picky extends Keeper {
    override public function feed(a:Animal, times:int = 1):String {
      return "picky " + super.feed(a, times + 1);
    }
  }
}
package {
  // Feeder's methods after others, so at other dispatch ids than Keeper's.
  public class Zoo implements Talker {
    public function open():String { return "open"; }
    public function close():String { return "close"; }
    public function talk(s:String):String { return "zoo says " + s; }
    public function count():int { return 100; }
    public function feed(a:Animal, times:int = 1):String {
      if (a == null) {
        throw new Error("no animal");
      }

      return "zoo " + a + "x" + times;
    }
  }
}
package {
  public class Plain {
    public function count():int { return -1; }
    public function feed(a:Animal, times:int = 1):String { return "plain " + a + "x" + times; }
  }
}
package {
  // Feeder's methods from a base that does not implement it.
  public class Heir extends Plain implements Feeder {}
}
package {
  public class Xml implements Feeder {
    public function count():int { return 7; }
    public function feed(a:Animal, times:int = 1):String {
      default xml namespace = "urn:z";
      var x:XML = <a/>;
      return "xml " + a + " " + x.name() + " " + times;
    }
  }
}
package {
  public class Deep implements Feeder {
    public function count():int { return 0; }
    public function feed(a:Animal, times:int = 1):String {
      var f:Feeder = this;
      return times <= 0 ? "deep " + a : f.feed(a, times - 1);
    }
  }
}
import flash.utils.ByteArray;
import flash.utils.IDataInput;

class Rock {}

function probe(name:String, f:Function):void {
  try {
    trace(name, f());
  } catch (e:Error) {
    trace(name, e.errorID, e);
  }
}

function feedAll(feeders:Vector.<Feeder>, a:Animal):String {
  var s:String = "";
  for (var i:int = 0; i < feeders.length; i++) {
    var f:Feeder = feeders[i];
    s += f.feed(a, i) + "; " + f.count() + "; ";
  }

  return s;
}

var feeders:Vector.<Feeder> = new <Feeder>[new Keeper(), new Picky(), new Zoo(), new Heir(), new Xml(), new Deep()];
var rock:* = new Rock();
var nothing:* = undefined;
var bytes:ByteArray = new ByteArray();
bytes.writeByte(5);
bytes.writeUTF("hi");
bytes.writeInt(-3);
for (var i:int = 0; i < 3; i++) {
  probe("all " + i, function ():* { return feedAll(feeders, new Dog()); });
  probe("all null " + i, function ():* { return feedAll(feeders, null); });
  probe("all again " + i, function ():* { return feedAll(feeders, new Animal("cat")); });
  probe("keeper " + i, function ():* { var f:Feeder = new Keeper(); return f.feed(new Dog()); });
  probe("picky " + i, function ():* { var f:Feeder = new Picky(); return f.feed(new Dog(), 2); });
  probe("heir " + i, function ():* { var f:Feeder = new Heir(); return f.feed(new Dog(), 3); });
  probe("wrong " + i, function ():* { var f:Feeder = new Zoo(); return f.feed(rock); });
  probe("undefined " + i, function ():* { var f:Feeder = new Zoo(); return f.feed(nothing); });
  probe("throws " + i, function ():* { var f:Feeder = new Zoo(); return f.feed(null); });
  probe("null receiver " + i, function ():* { var f:Feeder = null; return f.feed(new Dog()); });
  probe("null receiver count " + i, function ():* { var f:Feeder = null; return f.count(); });
  probe("untyped receiver " + i, function ():* { var u:* = new Picky(); var f:Feeder = u; return f.feed(new Dog()); });
  probe("not a feeder " + i, function ():* { var u:* = new Plain(); var f:Feeder = u; return f.feed(new Dog()); });
  probe("subinterface " + i, function ():* { var t:Talker = new Zoo(); return t.talk("hi") + " " + t.feed(new Dog(), 4) + " " + t.count(); });
  probe("subinterface as base " + i, function ():* { var t:Talker = new Zoo(); var f:Feeder = t; return f.count(); });
  probe("two interfaces " + i, function ():* { var k:Keeper = new Keeper(); var f:Feeder = k; var n:Named = k; return f.count() + n.count() + f.count(); });
  probe("rest " + i, function ():* { var m:Many = new Keeper(); return m.many(new Dog(), 1, 2, 3); });
  probe("rest none " + i, function ():* { var m:Many = new Picky(); return m.many(null); });
  probe("rest wrong " + i, function ():* { var m:Many = new Keeper(); return m.many(rock, 1); });
  probe("recursion " + i, function ():* { var f:Feeder = new Deep(); return f.feed(new Dog(), 40); });
  probe("native " + i, function ():* {
    bytes.position = 0;
    var d:IDataInput = bytes;
    return d.readByte() + " " + d.readUTF() + " " + d.readInt() + " " + d.bytesAvailable;
  });
  probe("native eof " + i, function ():* { bytes.position = 0; var d:IDataInput = bytes; return d.readDouble() + d.readDouble(); });
  probe("native into " + i, function ():* {
    bytes.position = 0;
    var d:IDataInput = bytes;
    var into:ByteArray = new ByteArray();
    d.readBytes(into, 1);
    return into.length;
  });
  probe("native into null " + i, function ():* { bytes.position = 0; var d:IDataInput = bytes; d.readBytes(null); return "read"; });
}
