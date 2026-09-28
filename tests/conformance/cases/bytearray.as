// ByteArray: reads and writes in both byte orders, UTF, lengths, positions,
// index access, and the errors past its end.
import flash.utils.ByteArray;
import flash.utils.Endian;
function hex(b:ByteArray):String {
  var s:String = "";
  for (var i:uint = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
}
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e.errorID, getQualifiedClassName(e)); }
}
import avmplus.getQualifiedClassName;
var b:ByteArray = new ByteArray();
trace(b.length, b.position, b.endian, b.bytesAvailable, b.objectEncoding);
b.writeByte(-1); b.writeByte(0x1ff); b.writeShort(-2); b.writeInt(0x12345678); b.writeUnsignedInt(4294967295);
b.writeBoolean(true); b.writeFloat(0.1); b.writeDouble(-1.5);
trace(hex(b), b.length, b.position);
b.position = 0;
trace(b.readByte(), b.readUnsignedByte(), b.readShort(), b.readInt().toString(16), b.readUnsignedInt(), b.readBoolean(), b.readFloat(), b.readDouble(), b.bytesAvailable);
var l:ByteArray = new ByteArray();
l.endian = Endian.LITTLE_ENDIAN;
l.writeInt(1); l.writeShort(0x102); l.writeDouble(1);
trace(hex(l), l.endian);
var u:ByteArray = new ByteArray();
u.writeUTF("héllo €"); u.writeUTFBytes("a\u0000b"); u.writeUTFBytes("😀");
trace(hex(u), u.length);
u.position = 0;
trace(u.readUTF(), u.readUTFBytes(3).length, u.readUTFBytes(4).charCodeAt(1));
var bom:ByteArray = new ByteArray();
bom.writeByte(0xef); bom.writeByte(0xbb); bom.writeByte(0xbf); bom.writeUTFBytes("x");
bom.writeByte(0xff); bom.writeByte(0x41);
bom.position = 0;
trace(bom.readUTFBytes(bom.length).length, bom.toString().length, bom.toString().charCodeAt(1));
b.length = 3;
trace(hex(b), b.position, b[1], b[5], 5 in b, 1 in b);
b[6] = 300;
trace(hex(b), b.length);
b.length = 0;
b.length = 4;
trace("regrow", hex(b));
b.clear();
trace(b.length, b.position);
var c:ByteArray = new ByteArray();
c.writeUTFBytes("abcdef");
var d:ByteArray = new ByteArray();
d.writeBytes(c, 2, 3);
d.writeBytes(c, 4);
c.position = 1;
c.readBytes(d, 7, 2);
trace(hex(d), d.length, c.position, d.toString());
probe("eof", function():* { var e:ByteArray = new ByteArray(); e.writeByte(1); e.position = 0; return e.readInt(); });
probe("eof utf", function():* { var e:ByteArray = new ByteArray(); return e.readUTFBytes(1); });
probe("endian", function():* { new ByteArray().endian = "middle"; });
probe("range", function():* { var e:ByteArray = new ByteArray(); e.writeBytes(c, 2, 10); });
probe("null", function():* { new ByteArray().writeBytes(null); });
probe("encoding", function():* { new ByteArray().objectEncoding = 1; });
var p:ByteArray = new ByteArray();
p.position = 5;
p.writeByte(9);
trace(hex(p), p.length, p.position);
