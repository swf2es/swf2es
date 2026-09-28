// AMF3 through ByteArray's writeObject and readObject: the bytes avmplus
// writes for each kind of value, and what reading them back gives.
package {
  public class Point3 {
    public var x:Number = 0;
    public var y:int = 0;
    public function Point3(x:Number = 0, y:int = 0) { this.x = x; this.y = y; }
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
trace("date", amf(when), amf(new Date(NaN)), amf([when, when]));
var dates:Array = back([when, {at: when}, new Date(0)]);
trace("dates back", dates[0].time, dates[0] is Date, dates[0] == dates[1].at, dates[2].time, dates[0].toUTCString());
var invalid:* = back(new Date(NaN));
trace("invalid back", invalid is Date, isNaN(invalid.time));
