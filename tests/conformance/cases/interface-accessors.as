// A getter and setter called through an interface type: the receiver's
// own, whatever place its class gives them among its methods.
package {
  public interface INamed {
    function get name():String;
    function set name(v:String):void;
    function get size():int;
  }
}
package {
  public class Named implements INamed {
    private var n:String = "first";
    public function before():String { return "before"; }
    public function alsoBefore():int { return 1; }
    public function get name():String { return n; }
    public function set name(v:String):void { n = v + "!"; }
    public function get size():int { return n.length; }
  }
}
package {
  public class Renamed extends Named {
    public function more():void {}
    override public function get name():String { return "renamed " + super.name; }
  }
}
package {
  import flash.utils.IDataOutput;
  import flash.utils.ByteArray;
  public class Writes {
    public static function run(out:IDataOutput):String {
      out.endian = "littleEndian";
      out.writeShort(1);
      return out.endian + " " + out.objectEncoding;
    }
  }
}
import flash.utils.ByteArray;
function show(o:INamed):String {
  o.name = "set";
  return o.name + " " + o.size;
}
trace(show(new Named()), show(new Renamed()));
var b:ByteArray = new ByteArray();
trace(Writes.run(b), b[0], b[1]);
