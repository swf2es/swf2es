// ByteArray's compress and uncompress, zlib, deflate and lzma, as avmplus'
// ByteArray does them: positions after, empty and short data, trailing
// bytes, corrupt data (the ByteArray as it was), algorithm names, and the
// domain memory. zlib and deflate write zlib's own bytes (pako is a port);
// lzma's differ between encoders, so only its round trips are compared.
import flash.utils.ByteArray;
import avmplus.Domain;
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e.errorID, e is ArgumentError ? "ArgumentError" : e is TypeError ? "TypeError" : "Error"); }
}
function hex(b:ByteArray):String {
  var s:String = "";
  for (var i:int = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
}
function text(s:String):ByteArray { var b:ByteArray = new ByteArray(); b.writeUTFBytes(s); return b; }
var sample:String = "hello hello hello hello, compress me! swf2es and avmplus; 0123456789 0123456789";
for each (var algorithm:String in ["zlib", "deflate", "lzma"]) {
  var b:ByteArray = text(sample);
  b.position = 3;
  b.compress(algorithm);
  var compressed:uint = b.length;
  trace(algorithm, "compressed position", b.position == b.length, algorithm == "lzma" ? "" : hex(b));
  b.position = 5;
  b.uncompress(algorithm);
  trace(algorithm, "back", b.position, b.length, b.readUTFBytes(b.length) == sample);
}
// Larger, and repetitive: many matches, and a stored block's worth.
var big:ByteArray = new ByteArray();
for (var i:int = 0; i < 70000; i++) big.writeByte((i * 7 + (i >> 5)) & 255);
var copy:ByteArray = new ByteArray();
copy.writeBytes(big);
big.compress();
trace("big zlib", big.length, hex(big).substr(0, 64));
big.uncompress();
var same:Boolean = big.length == copy.length;
for (i = 0; same && i < big.length; i++) same = big[i] == copy[i];
trace("big back", big.length, same);
big.compress("lzma");
big.uncompress("lzma");
trace("big lzma back", big.length, big[69999] == copy[69999]);
// deflate() and inflate() are compress("deflate") and uncompress("deflate").
var d:ByteArray = text(sample);
d.deflate();
trace("deflate()", hex(d));
d.inflate();
trace("inflate()", d.toString() == sample);
// Empty: nothing happens, the position kept.
var empty:ByteArray = new ByteArray();
empty.compress();
trace("empty compress", empty.length, empty.position);
empty.uncompress();
empty.uncompress("lzma");
trace("empty uncompress", empty.length, empty.position);
// Trailing bytes after a zlib stream are left out.
var trailing:ByteArray = text(sample);
trailing.compress();
trailing.position = trailing.length;
trailing.writeUTFBytes("tail");
trailing.uncompress();
trace("trailing", trailing.length, trailing.toString() == sample);
// Corrupt, truncated or unknown: an IOError, the ByteArray as it was.
var bad:ByteArray = text("not compressed at all");
bad.position = 4;
probe("corrupt zlib", function():* { bad.uncompress(); });
trace("after corrupt", bad.length, bad.position, bad.toString());
probe("corrupt deflate", function():* { var x:ByteArray = new ByteArray(); x.writeByte(0xff); x.writeByte(0xff); x.uncompress("deflate"); return x.length; });
var cut:ByteArray = text(sample);
cut.compress();
cut.length = cut.length - 5;
probe("truncated zlib", function():* { cut.uncompress(); });
var checksum:ByteArray = text(sample);
checksum.compress();
checksum[checksum.length - 1] ^= 1;
probe("bad checksum", function():* { checksum.uncompress(); });
probe("unknown algorithm", function():* { text("x").compress("gzip"); });
probe("null algorithm", function():* { text("x").compress(null); });
probe("unknown uncompress", function():* { text("x").uncompress("zip"); });
// lzma: shorter than its header is left as it is; a length past 32 bits fails first.
var shortLzma:ByteArray = text("short");
shortLzma.uncompress("lzma");
trace("short lzma", shortLzma.toString());
var huge:ByteArray = new ByteArray();
huge.writeBytes(text("abcdefghijklmnopqrst"));
huge[9] = 1;
probe("lzma past 32 bits", function():* { huge.uncompress("lzma"); });
var corruptLzma:ByteArray = new ByteArray();
for (i = 0; i < 20; i++) corruptLzma.writeByte(i == 0 ? 0x5d : i < 5 ? 0 : i == 5 ? 10 : i < 13 ? 0 : 0xee);
probe("corrupt lzma", function():* { corruptLzma.uncompress("lzma"); });
trace("after corrupt lzma", corruptLzma.length);
// Properties: 200 (lc 2, lp 2, pb 4) as xz wrote it, then 225 and 255, which no encoder writes.
function fromHex(h:String):ByteArray {
  var b:ByteArray = new ByteArray();
  for (var k:int = 0; k < h.length; k += 2) b.writeByte(parseInt(h.substr(k, 2), 16));
  return b;
}
var xz:String = "c800008000490000000000000000399dc8c32333afd03022ad2a9d4ab23cb281e7173980d279aa96f6d60439387df25a361e6cad2824572838209183ffffe4050000";
var props200:ByteArray = fromHex(xz);
props200.uncompress("lzma");
trace("lzma properties 200", props200.toString());
for each (var props:int in [225, 255]) {
  var badProps:ByteArray = fromHex(xz);
  badProps[0] = props;
  probe("lzma properties " + props, function():* { badProps.uncompress("lzma"); });
}
// A dictionary the header gives as 1 KB is 4 KB, as LzmaDec reads it: a
// repeat 1100 bytes back still decodes.
var repeated:ByteArray = new ByteArray();
var x:int = 1;
for (i = 0; i < 1100; i++) { x = (x * 75 + 74) % 65537; repeated.writeByte(x & 255); }
repeated.writeBytes(repeated, 0, 1100);
var expected:String = hex(repeated);
repeated.compress("lzma");
repeated[1] = 0; repeated[2] = 4; repeated[3] = 0; repeated[4] = 0;
probe("lzma dictionary 1024", function():* {
  repeated.uncompress("lzma");
  return repeated.length + " " + (hex(repeated) == expected);
});
// Zeros decode to zeros for as long as they last: past them is past the stream.
var zeros:ByteArray = new ByteArray();
for (i = 0; i < 26; i++) zeros.writeByte(i == 0 ? 0x5d : i == 3 ? 1 : i == 5 ? 0xa0 : i == 6 ? 0x86 : i == 7 ? 1 : 0);
probe("lzma past its stream", function():* { zeros.uncompress("lzma"); });
// The domain memory's bytes cannot change under it.
var memory:ByteArray = new ByteArray();
memory.length = 1024;
Domain.currentDomain.domainMemory = memory;
probe("domain memory compress", function():* { memory.compress(); });
probe("domain memory uncompress", function():* { memory.uncompress(); });
Domain.currentDomain.domainMemory = null;
