// NaN in bytes: avmplus' constant NaN (NaN, Number.NaN, parseFloat, an
// invalid Date) writes as 0x7fffffffe0000000, 0x7fffffff as a float; one an
// operation makes (0/0) as the hardware's 0xfff8.... Through writeDouble,
// writeFloat, AMF doubles, Dates and Vectors, domain memory, either byte order.
import flash.utils.ByteArray;
import avmplus.Domain;
import avm2.intrinsics.memory.*;
function bytes(f:Function):String { var b:ByteArray = new ByteArray(); f(b); var s:String = ""; for (var i:int = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16); return s; }
var zero:Number = 0;
var nans:Array = [["NaN", NaN], ["Number.NaN", Number.NaN], ["0/0", zero / zero], ["parseFloat", parseFloat("x")], ["Number(str)", Number("x")], ["Math.sqrt", Math.sqrt(-1)], ["date time", new Date(NaN).time], ["inf-inf", Infinity - Infinity]];
for each (var n:Array in nans) {
  var v:Number = n[1];
  trace(n[0], bytes(function(b:ByteArray):void { b.writeDouble(v); }), bytes(function(b:ByteArray):void { b.writeFloat(v); }), bytes(function(b:ByteArray):void { b.writeObject(v); }));
}
trace("date amf", bytes(function(b:ByteArray):void { b.writeObject(new Date(NaN)); }));
var d:Date = new Date(2000, 1, 1);
d.time = NaN;
trace("date set NaN", bytes(function(b:ByteArray):void { b.writeObject(d); }));
var d2:Date = new Date(NaN);
d2.fullYear = 2000;
trace("date from invalid", d2.time);
var mem:ByteArray = new ByteArray();
mem.length = 1024;
Domain.currentDomain.domainMemory = mem;
sf64(NaN, 0); sf64(zero / zero, 8); sf32(NaN, 16);
var ms:String = ""; for (var k:int = 0; k < 20; k++) ms += (mem[k] < 16 ? "0" : "") + mem[k].toString(16);
trace("domain memory", ms);
Domain.currentDomain.domainMemory = null;
trace("vector amf", bytes(function(b:ByteArray):void { b.writeObject(new <Number>[NaN, zero / zero]); }));
trace("little", bytes(function(b:ByteArray):void { b.endian = "littleEndian"; b.writeDouble(NaN); b.writeFloat(NaN); }));
