// Calls through an interface by the name every implementing class has an
// alias of: one site seeing many classes, overrides two and three deep,
// an interface a subclass names again or a base implements, members
// inherited from a base that names no interface and then overridden,
// super-interfaces, two interfaces whose methods share a name in their
// own namespaces, a package-internal interface, a file's private
// interface, and natives (ByteArray as IDataInput and IDataOutput, a
// subclass of it that overrides one, and one that adds an interface).
package {
  public interface Shape {
    function area():Number;
    function label(prefix:String):String;
  }
}
package {
  public interface Solid extends Shape {
    function volume(depth:Number):Number;
  }
}
package {
  public interface Counted {
    function label(prefix:String):String;
  }
}
package {
  internal interface Hidden {
    function secret():String;
  }
}
package {
  public class Box implements Shape, Hidden {
    public var w:Number;
    public function Box(w:Number = 2) { this.w = w; }
    public function area():Number { return w * w; }
    public function label(prefix:String):String { return prefix + " box " + w; }
    public function secret():String { return "box secret"; }
    public static function hidden(o:*):String { var h:Hidden = o; return h.secret(); }
  }
}
package {
  public class Crate extends Box {
    public function Crate() { super(3); }
    override public function area():Number { return super.area() + 1; }
  }
}
package {
  // Names Shape again, as its base already implements it.
  public class Chest extends Crate implements Shape, Counted {
    override public function label(prefix:String):String { return prefix + " chest"; }
    override public function secret():String { return "chest secret"; }
  }
}
package {
  public class Trunk extends Chest {}
}
package {
  public class Cube extends Box implements Solid {
    public function extra():int { return 0; }
    public function volume(depth:Number):Number { return area() * depth; }
  }
}
package {
  // Shape's methods from a base that names no interface, one overridden here.
  public class Plain {
    public function first():int { return 1; }
    public function area():Number { return -1; }
    public function label(prefix:String):String { return prefix + " plain"; }
  }
}
package {
  public class Heir extends Plain implements Shape {
    override public function label(prefix:String):String { return prefix + " heir"; }
  }
}
package {
  public class Grandheir extends Heir {
    override public function area():Number { return -2; }
  }
}
package {
  import flash.utils.ByteArray;

  public class Bytes extends ByteArray {
    override public function readByte():int { return 100 + super.readByte(); }
  }
}
package {
  import flash.utils.ByteArray;

  public class ShapedBytes extends ByteArray implements Shape {
    public function area():Number { return length; }
    public function label(prefix:String):String { return prefix + " bytes " + length; }
  }
}
import flash.utils.ByteArray;
import flash.utils.IDataInput;
import flash.utils.IDataOutput;

interface Secret {
  function hide(n:int):String;
}

class Safe implements Secret {
  public function hide(n:int):String { return "safe " + n; }
}

class Vault extends Safe {
  override public function hide(n:int):String { return "vault " + n; }
}

function probe(name:String, f:Function):void {
  try {
    trace(name, f());
  } catch (e:Error) {
    trace(name, e.errorID, e);
  }
}

function areas(shapes:Vector.<Shape>):String {
  var s:String = "";
  for (var i:int = 0; i < shapes.length; i++) {
    var shape:Shape = shapes[i];
    s += shape.area() + " " + shape.label("#" + i) + "; ";
  }

  return s;
}

function volumes(solids:Array):String {
  var s:String = "";
  for (var i:int = 0; i < solids.length; i++) {
    var solid:Solid = solids[i];
    var shape:Shape = solid;
    s += solid.volume(i) + " " + solid.area() + " " + solid.label("s") + " " + shape.label("t") + "; ";
  }

  return s;
}

var shaped:ShapedBytes = new ShapedBytes();
shaped.writeInt(1);
var shapes:Vector.<Shape> = new <Shape>[
  new Box(), new Crate(), new Chest(), new Trunk(), new Cube(), new Heir(), new Grandheir(), shaped,
];
for (var i:int = 0; i < 3; i++) {
  probe("areas " + i, function ():* { return areas(shapes); });
  probe("areas again " + i, function ():* { return areas(shapes.slice(2)); });
  probe("solids " + i, function ():* { return volumes([new Cube(), new Cube(5)]); });
  probe("counted " + i, function ():* {
    var chest:Chest = new Trunk();
    var c:Counted = chest;
    var s:Shape = chest;
    return c.label("c") + " " + s.label("s");
  });
  probe("hidden " + i, function ():* { return Box.hidden(new Box()) + " " + Box.hidden(new Chest()) + " " + Box.hidden(new Trunk()); });
  probe("private " + i, function ():* {
    var safes:Array = [new Safe(), new Vault()];
    var s:String = "";
    for (var k:int = 0; k < safes.length; k++) {
      var x:Secret = safes[k];
      s += x.hide(k) + "; ";
    }

    return s;
  });
  probe("null " + i, function ():* { var s:Shape = null; return s.label("x"); });
  probe("natives " + i, function ():* {
    var out:Array = [new ByteArray(), new Bytes(), shaped];
    var s:String = "";
    for (var k:int = 0; k < out.length; k++) {
      var o:IDataOutput = out[k];
      o.writeByte(k + 1);
      var b:ByteArray = out[k];
      b.position = b.length - 1;
      var d:IDataInput = b;
      s += d.readByte() + " " + d.bytesAvailable + "; ";
    }

    return s;
  });
}
