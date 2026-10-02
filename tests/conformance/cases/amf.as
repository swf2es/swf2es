// AMF3 through ByteArray's writeObject and readObject: the bytes avmplus
// writes for each kind of value, and what reading them back gives.
package {
  public class Point3 {
    public var x:Number = 0;
    public var y:int = 0;
    public function Point3(x:Number = 0, y:int = 0) { this.x = x; this.y = y; }
  }
}
package {
  import flash.utils.IDataInput;
  import flash.utils.IDataOutput;
  import flash.utils.IExternalizable;
  // Writes itself: a short in the stream's byte order, a string, an object.
  public class Packed implements IExternalizable {
    public var n:int = 0;
    public var tag:String = "";
    public var more:Object = null;
    public function writeExternal(output:IDataOutput):void {
      output.writeShort(n);
      output.endian = "littleEndian";
      output.writeShort(n);
      output.writeUTF(tag);
      output.writeObject(more);
      trace("written", output.objectEncoding, output.endian);
    }
    public function readExternal(input:IDataInput):void {
      n = input.readShort();
      input.endian = "littleEndian";
      trace("read", input.readShort() == n, input.bytesAvailable);
      tag = input.readUTF();
      more = input.readObject();
    }
  }
}
package {
  import flash.utils.IDataInput;
  import flash.utils.IDataOutput;
  import flash.utils.IExternalizable;
  public class Unaliased implements IExternalizable {
    public function writeExternal(output:IDataOutput):void {}
    public function readExternal(input:IDataInput):void {}
  }
}
package {
  import flash.net.IDynamicPropertyOutput;
  import flash.net.IDynamicPropertyWriter;
  // Writes only the names that start with "k", and one of its own.
  public class KeysOnly implements IDynamicPropertyWriter {
    public function writeDynamicProperties(obj:Object, output:IDynamicPropertyOutput):void {
      for (var name:String in obj) {
        if (name.charAt(0) == "k") {
          output.writeDynamicProperty(name, obj[name]);
        }
      }
      output.writeDynamicProperty("added", 1);
    }
  }
}
import flash.utils.ByteArray;
import flash.net.registerClassAlias;
import flash.net.getClassByAlias;
function amf(v:*):String {
  var b:ByteArray = new ByteArray();
  b.writeObject(v);
  var hex:String = "";
  for (var i:uint = 0; i < b.length; i++) hex += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return hex;
}
function back(v:*):* {
  var b:ByteArray = new ByteArray();
  b.writeObject(v);
  b.position = 0;
  return b.readObject();
}
trace(amf(undefined), amf(null), amf(true), amf(false), amf(0), amf(-1), amf(268435455), amf(268435456), amf(1.5), amf(-0));
trace(amf("hi"), amf(""), amf(["a", "a"]), amf([1, 2]), amf(new <int>[1, -1]), amf(new <uint>[3]), amf(new <Number>[0.5]));
var ba:ByteArray = new ByteArray();
ba.writeByte(7);
trace(amf(ba), amf({}), amf({k: "v"}), amf(new <String>["s"]));
registerClassAlias("test.Point3", Point3);
trace(amf(new Point3(1.5, 2)).length, getClassByAlias("test.Point3") == Point3);
var pt:* = back(new Point3(2.5, 3));
trace(pt is Point3, pt.x, pt.y);
var arr:Array = back([1, "two", null, [3], {four: 4}]);
trace(arr.length, arr[0], arr[1], arr[2], arr[3][0], arr[4].four);
var sparse:Array = [];
sparse[2] = "c";
trace(amf(sparse), back(sparse).length, back(sparse)[2]);
var shared:Object = {n: 1};
var two:Array = back([shared, shared]);
trace(two[0] == two[1], back(new <int>[5, 6]), back(ba).length, back("é€"), back(1e100));
try { getClassByAlias("nope"); } catch (e:Error) { trace("missing alias", e.errorID); }
// AMF is big-endian whatever the ByteArray's byte order.
var le:ByteArray = new ByteArray();
le.endian = "littleEndian";
le.writeObject(1.5);
le.writeObject(new <int>[1]);
le.writeObject(new <Number>[2.5]);
var leHex:String = "";
for (var li:uint = 0; li < le.length; li++) leHex += (le[li] < 16 ? "0" : "") + le[li].toString(16);
le.position = 0;
trace("little", leHex, le.readObject(), le.readObject(), le.readObject());
// A new ByteArray takes defaultObjectEncoding as it is then.
ByteArray.defaultObjectEncoding = 0;
var zero:ByteArray = new ByteArray();
ByteArray.defaultObjectEncoding = 3;
trace("default", zero.objectEncoding, new ByteArray().objectEncoding, ByteArray.defaultObjectEncoding);
try { zero.writeObject(1); } catch (e:Error) { trace("amf0", e.errorID); }
// Dates: a reference into the objects' table, else 1 and the time as a double.
var when:Date = new Date(Date.UTC(2004, 8, 12, 11, 11, 11, 500));
// An invalid Date's time is a NaN, whose bits are free (see nan-bytes.as).
trace("date", amf(when), amf(new Date(NaN)).length, amf([when, when]));
var dates:Array = back([when, {at: when}, new Date(0)]);
trace("dates back", dates[0].time, dates[0] is Date, dates[0] == dates[1].at, dates[2].time, dates[0].toUTCString());
var invalid:* = back(new Date(NaN));
trace("invalid back", invalid is Date, isNaN(invalid.time));
// Numeric Vectors large enough to grow the ByteArray while they are written.
var bigD:Vector.<Number> = new Vector.<Number>();
var bigI:Vector.<int> = new Vector.<int>();
var bigU:Vector.<uint> = new Vector.<uint>();
for (var bv:int = 0; bv < 5000; bv++) { bigD.push(bv / 3); bigI.push(bv * -7); bigU.push(0xfffffff0 + bv % 16); }
var grow:ByteArray = new ByteArray();
grow.writeUTFBytes("prefix");
grow.writeObject(bigD); grow.writeObject(bigI); grow.writeObject(bigU);
var sumBytes:uint = 0;
for (var gb:uint = 0; gb < grow.length; gb++) sumBytes = (sumBytes * 31 + grow[gb]) >>> 0;
grow.position = 6;
var gd:Vector.<Number> = grow.readObject(), gi:Vector.<int> = grow.readObject(), gu:Vector.<uint> = grow.readObject();
trace("big vectors", grow.length, sumBytes, gd.length, gd[4999] == bigD[4999], gi[4999], gu[4999], gu[15]);
// One class for each Vector type, however it is reached; typed Vectors
// read back, one of a class with no alias as Vector.<Object>.
var vp:Vector.<Point3> = new <Point3>[new Point3(1, 2), null];
var vpBack:* = back(vp);
trace("vector classes", vpBack is Vector.<Point3>, Object(vpBack).constructor == Vector.<Point3>, Vector.<Point3> == Vector.<Point3>, Object(back(new <int>[1])).constructor == Vector.<int>, Object(back(new Vector.<*>())).constructor == Vector.<*>);
trace("vector point", vpBack.length, vpBack[0].x, vpBack[0].y, vpBack[1], vpBack.fixed, back(new Vector.<int>(2, true)).fixed);
var vs:Vector.<String> = new <String>["a", null, "c"];
var vsBack:* = back(vs);
trace("vector string", vsBack is Vector.<String>, vsBack is Vector.<Object>, vsBack.join("|"), back(new <Array>[[1]]) is Vector.<Object>, back(new <uint>[0xffffffff, 1])[0], back(new <int>[-1, 0x7fffffff])[0]);
// Truncated data: the error, and the position it leaves, for numeric
// Vectors and short strings cut short, and whole ones read at the end.
function cut(v:*, drop:int):String {
  var b:ByteArray = new ByteArray();
  b.writeObject(v);
  var c:ByteArray = new ByteArray();
  c.writeBytes(b, 0, b.length - drop);
  c.position = 0;
  try {
    var r:* = c.readObject();
    return "ok " + r + " at " + c.position;
  } catch (e:Error) {
    return e.errorID + " at " + c.position;
  }
  return "";
}
trace("truncated", cut(new <int>[1, 2, 3], 0), cut(new <int>[1, 2, 3], 1), cut(new <int>[1, 2, 3], 5), cut(new <uint>[7, 8], 3), cut(new <Number>[0.5, 1.5], 1), cut(new <Number>[0.5, 1.5], 9));
trace("truncated strings", cut("short", 0), cut("short", 1), cut("short", 5), cut("abcdefghijklmnopqrstuvwxyz", 3), cut("é€", 1), cut(["ab", "ab"], 0), cut(["ab", "ab"], 1));
// Empty Vectors at the very end of the data, each numeric kind and Object's.
function emptyAtEnd(v:*):String {
  var b:ByteArray = new ByteArray();
  b.writeObject(v);
  b.position = 0;
  try {
    var r:* = b.readObject();
    return r.length + " at " + b.position + "/" + b.length;
  } catch (e:Error) {
    return e.errorID + " at " + b.position;
  }
  return "";
}
trace("empty at end", emptyAtEnd(new Vector.<int>()), emptyAtEnd(new Vector.<uint>()), emptyAtEnd(new Vector.<Number>()), emptyAtEnd(new Vector.<Object>()), emptyAtEnd(new Vector.<int>(0, true)));
// XML as its toXMLString, a second time as a reference; an XMLList as an object.
var x:XML = <a b="1"><c>t</c></a>;
trace(amf(x), amf([x, x]), amf(<f>hi</f>));
var xs:Array = back([x, x]);
trace(xs[0].toXMLString().split("\n").join("|"), xs[0] === xs[1], xs[0] is XML);
// An IExternalizable writes and reads itself, sharing the stream's tables.
registerClassAlias("Packed", Packed);
var p:Packed = new Packed();
p.n = 258;
p.tag = "t";
p.more = {k: "t"};
trace(amf(p));
var q:Packed = back(p);
trace(q.n, q.tag, q.more.k);
try { amf(new Unaliased()); } catch (e:Error) { trace(e); }
registerClassAlias("Point3", Point3);
var notExternal:ByteArray = new ByteArray();
notExternal.writeByte(10);
notExternal.writeByte(7);
notExternal.writeByte(13);
notExternal.writeUTFBytes("Point3");
notExternal.position = 0;
try { notExternal.readObject(); } catch (e:Error) { trace(e); }
// A dynamicPropertyWriter decides what of a dynamic object's own is written.
import flash.net.ObjectEncoding;
ObjectEncoding.dynamicPropertyWriter = new KeysOnly();
trace(ObjectEncoding.dynamicPropertyWriter is KeysOnly, amf({k1: 1, other: 2}));
ObjectEncoding.dynamicPropertyWriter = null;
trace(ObjectEncoding.dynamicPropertyWriter, amf({k1: 1}));
