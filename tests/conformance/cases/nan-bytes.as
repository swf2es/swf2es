// NaN in bytes. Which NaN's bits a NaN writes as is free: avmplus' constant
// NaN is 0x7fffffffe0000000 where V8's is 0x7ff8..., and bits can't tell
// where a NaN came from. So each NaN must write as some NaN and read back
// as NaN, through writeDouble, writeFloat, AMF doubles, Dates and Vectors,
// domain memory, and either byte order; and a NaN read from bytes writes
// back as the bits it was read from.
import flash.utils.ByteArray;
import avmplus.Domain;
import avm2.intrinsics.memory.*;
function hex(b:ByteArray, from:int = 0, to:int = -1):String {
  var s:String = "";
  for (var i:int = from; i < (to < 0 ? b.length : to); i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  return s;
}
// Whether the 8 bytes (or 4) at `at` are a NaN: every exponent bit set, and some mantissa bit.
function isNaNDouble(b:ByteArray, at:int, little:Boolean = false):String {
  var x:Array = [];
  for (var i:int = 0; i < 8; i++) x.push(b[at + (little ? 7 - i : i)]);
  var mantissa:Boolean = (x[1] & 0x0f) != 0 || x[2] || x[3] || x[4] || x[5] || x[6] || x[7];
  return (x[0] & 0x7f) == 0x7f && (x[1] & 0xf0) == 0xf0 && mantissa ? "nan" : "not " + hex(b, at, at + 8);
}
function isNaNFloat(b:ByteArray, at:int, little:Boolean = false):String {
  var x:Array = [];
  for (var i:int = 0; i < 4; i++) x.push(b[at + (little ? 3 - i : i)]);
  var mantissa:Boolean = (x[1] & 0x7f) != 0 || x[2] || x[3];
  return (x[0] & 0x7f) == 0x7f && (x[1] & 0x80) != 0 && mantissa ? "nan" : "not " + hex(b, at, at + 4);
}
var zero:Number = 0;
var nans:Array = [["NaN", NaN], ["Number.NaN", Number.NaN], ["0/0", zero / zero], ["parseFloat", parseFloat("x")], ["Number(str)", Number("x")], ["Math.sqrt", Math.sqrt(-1)], ["date time", new Date(NaN).time], ["inf-inf", Infinity - Infinity]];
for each (var n:Array in nans) {
  var b:ByteArray = new ByteArray();
  b.writeDouble(n[1]);
  b.writeFloat(n[1]);
  b.writeObject(n[1]);
  b.position = 0;
  trace(n[0], isNaNDouble(b, 0), isNaNFloat(b, 8), b[12], isNaNDouble(b, 13), isNaN(b.readDouble()), isNaN(b.readFloat()), isNaN(b.readObject()));
}
var dates:ByteArray = new ByteArray();
dates.writeObject(new Date(NaN));
var d:Date = new Date(2000, 1, 1);
d.time = NaN;
dates.writeObject(d);
dates.position = 0;
trace("date amf", dates.length, isNaN(dates.readObject().time), isNaN(dates.readObject().time));
var d2:Date = new Date(NaN);
d2.fullYear = 2000;
trace("date from invalid", d2.time);
var mem:ByteArray = new ByteArray();
mem.length = 1024;
Domain.currentDomain.domainMemory = mem;
sf64(NaN, 0); sf64(zero / zero, 8); sf32(NaN, 16);
trace("domain memory", isNaNDouble(mem, 0, true), isNaNDouble(mem, 8, true), isNaNFloat(mem, 16, true), isNaN(lf64(0)), isNaN(lf32(16)));
Domain.currentDomain.domainMemory = null;
var vec:ByteArray = new ByteArray();
vec.writeObject(new <Number>[NaN, zero / zero]);
vec.position = 0;
var back:Vector.<Number> = vec.readObject();
trace("vector amf", vec.length, back.length, isNaN(back[0]), isNaN(back[1]));
var little:ByteArray = new ByteArray();
little.endian = "littleEndian";
little.writeDouble(NaN);
little.writeFloat(NaN);
trace("little", isNaNDouble(little, 0, true), isNaNFloat(little, 8, true));
// A NaN read from bytes writes back as its bits.
var raw:ByteArray = new ByteArray();
raw.writeUnsignedInt(0x7ff80000);
raw.writeUnsignedInt(0);
raw.writeUnsignedInt(0x7fc00000);
raw.position = 0;
var again:ByteArray = new ByteArray();
again.writeDouble(raw.readDouble());
again.writeFloat(raw.readFloat());
trace("read back", hex(again));
