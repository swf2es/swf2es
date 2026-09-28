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
// A large UTF-16 buffer converts whole.
var big:ByteArray = new ByteArray();
big.writeByte(0xfe); big.writeByte(0xff);
for (var bi:int = 0; bi < 200000; bi++) { big.writeByte(0); big.writeByte(0x41 + bi % 26); }
var bs:String = big.toString();
trace("utf-16", bs.length, bs.substr(0, 5), bs.charAt(199999));
// UTF-8 of strings short and long, either side of where swf2es hands them
// to the host's encoder, with a surrogate pair as four bytes. Lone
// surrogates are left out: avmshell loses characters around them (a lone
// high one takes the character after it, and one at the end disappears),
// where swf2es writes each as U+FFFD, valid UTF-8 that keeps the rest.
function utf8Sum(s:String):String {
  var b:ByteArray = new ByteArray();
  b.writeUTFBytes(s);
  var sum:uint = 0;
  for (var i:uint = 0; i < b.length; i++) sum = (sum * 31 + b[i]) >>> 0;
  var u:ByteArray = new ByteArray();
  u.writeUTF(s);
  u.position = 0;
  return b.length + ":" + sum + ":" + (u.readUTF() == s);
}
var sizes:Array = [];
for each (var size:int in [95, 96, 97, 300]) {
  var ascii:String = "";
  while (ascii.length < size) ascii += "abc " + ascii.length;
  ascii = ascii.substr(0, size);
  sizes.push(utf8Sum(ascii), utf8Sum(ascii.substr(0, size - 2) + "é€"), utf8Sum(ascii.substr(0, size - 3) + "😀x"));
}
trace("utf8 sizes", sizes.join(" "));
// Reading UTF-8 back, either side of 16 bytes, where swf2es first looks for
// ASCII, and of 8192, where it makes the string in pieces; through
// readUTFBytes, readUTF and AMF.
function readBack(s:String):String {
  var b:ByteArray = new ByteArray();
  b.writeUTFBytes(s);
  b.position = 0;
  var r:String = b.readUTFBytes(b.length);
  var u:ByteArray = new ByteArray();
  u.writeUTF(s);
  u.position = 0;
  var a:ByteArray = new ByteArray();
  a.writeObject([s, s]);
  a.position = 0;
  var back:Array = a.readObject();
  return r.length + ":" + (r == s) + (u.readUTF() == s) + (back[0] == s) + (back[1] == s);
}
var reads:Array = [];
for each (var rn:int in [0, 1, 15, 16, 17, 100, 8191, 8192, 8193, 20000]) {
  var rs:String = "";
  while (rs.length < rn) rs += "x" + rs.length;
  rs = rs.substr(0, rn);
  reads.push(readBack(rs), readBack(rs.substr(0, rn > 0 ? rn - 1 : 0) + "é"));
}
trace("utf8 reads", reads.join(" "));
