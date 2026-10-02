// Domain memory at addresses typed int and uint, which the emitter loads
// and stores in place: each width at the end and one past it, a uint past
// 2^31 and a negative int, values of each type, and memory that grows,
// shrinks or is replaced between accesses.
import avmplus.Domain;
import flash.utils.ByteArray;
import avm2.intrinsics.memory.*;
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e.errorID); }
}

var mem:ByteArray = new ByteArray();
mem.length = 1024;
Domain.currentDomain.domainMemory = mem;

function loads(at:int):String {
  var out:Array = [];
  try { out.push(li8(at)); } catch (e:Error) { out.push("8:" + e.errorID); }
  try { out.push(li16(at)); } catch (e:Error) { out.push("16:" + e.errorID); }
  try { out.push(li32(at)); } catch (e:Error) { out.push("32:" + e.errorID); }
  try { out.push(lf32(at)); } catch (e:Error) { out.push("f32:" + e.errorID); }
  try { out.push(lf64(at)); } catch (e:Error) { out.push("f64:" + e.errorID); }
  return out.join(" ");
}
function unsignedLoad(at:uint):String {
  try { return String(li8(at)); } catch (e:Error) { return "u8:" + e.errorID; }
  return "";
}
for each (var at:int in [0, 1016, 1017, 1020, 1021, 1022, 1023, 1024, -1, -8, int.MIN_VALUE]) {
  trace(at, loads(at));
}
trace(unsignedLoad(5), unsignedLoad(1023), unsignedLoad(1024), unsignedLoad(0x80000000), unsignedLoad(0xffffffff));

function stores(at:int, i:int, u:uint, n:Number, b:Boolean):void {
  si8(i, at); si8(u, at + 1); si8(n, at + 2); si8(b, at + 3);
  si16(i, at + 4); si16(n, at + 6);
  si32(i, at + 8); si32(u, at + 12); si32(n, at + 16); si32(b, at + 20);
  sf32(n, at + 24); sf32(i, at + 28); sf64(n, at + 32); sf64(u, at + 40);
}
stores(64, -1, 0xffffffff, 3.75, true);
trace(li8(64), li8(65), li8(66), li8(67), li16(68), li16(70), li32(72), li32(76), li32(80), li32(84));
trace(lf32(88), lf32(92), lf64(96), lf64(104));
stores(128, 0x12345678, 0x80000000, NaN, false);
trace(li8(128), li8(129), li8(130), li8(131), li16(132), li16(134), li32(136), li32(140), li32(144), li32(148));
trace(lf32(152), lf32(156), lf64(160), lf64(168));
stores(192, 0, 0, -2147483649.5, false);
trace(li32(208), li8(194), li16(198), lf32(216));
stores(192, 0, 0, 4294967296 * 3 + 7, false);
trace(li32(208), li8(194), li16(198));
probe("store past end", function():* { var at:int = 1021; si32(1, at); });
probe("store negative", function():* { var at:int = -4; si32(1, at); });
probe("store f64 past end", function():* { var at:int = 1017; sf64(1, at); });
probe("store unsigned past 2^31", function():* { var at:uint = 0x80000000; si8(1, at); });

// The memory grows, shrinks and is replaced: each access sees it as it is now.
var i:int = 1020;
si32(11, i);
mem.length = 2048;
var j:int = 2044;
si32(12, j);
trace(li32(i), li32(j), mem.length);
mem.length = 1024;
probe("after shrink", function():* { return li32(j); });
var other:ByteArray = new ByteArray();
other.length = 4096;
Domain.currentDomain.domainMemory = other;
var k:int = 4092;
si32(13, k);
trace(li32(k), li32(i), other.length);
Domain.currentDomain.domainMemory = mem;
trace(li32(i));
probe("old memory's end", function():* { return li32(k); });

// A loop of typed accesses, as compiled C code makes: a checksum of the memory.
var sum:int = 0;
for (var p:int = 0; p < 1024; p += 4) {
  si32(p * 31, p);
}
for (p = 0; p < 1024; p += 4) {
  sum = (sum ^ li32(p)) + li8(p + 1) | 0;
}
trace("sum", sum);
