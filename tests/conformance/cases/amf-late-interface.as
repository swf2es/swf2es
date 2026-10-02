// A class whose interface its script makes after it, serialized in its
// own static initializer before that interface exists: once the script has
// made it, the class writes itself as the IExternalizable it is. (What the
// first write gives avmplus sees already; swf2es does not yet.)
package {
  import flash.net.registerClassAlias;
  import flash.utils.ByteArray;
  import flash.utils.IDataInput;
  import flash.utils.IDataOutput;
  public class Early implements ILate {
    public var n:int = 7;
    public static var before:String = Early.hex();
    public static function hex():String {
      registerClassAlias("Early", Early);
      var b:ByteArray = new ByteArray();
      b.writeObject(new Early());
      var out:String = "";
      for (var i:uint = 0; i < b.length; i++) {
        out += (b[i] < 16 ? "0" : "") + b[i].toString(16);
      }
      return out;
    }
    public function writeExternal(output:IDataOutput):void {
      output.writeByte(n);
    }
    public function readExternal(input:IDataInput):void {
      n = input.readByte();
    }
  }
}
package {
  import flash.utils.IExternalizable;
  public interface ILate extends IExternalizable {}
}
trace(Early.before.length > 0, Early.hex());
