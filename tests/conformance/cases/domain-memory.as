// Domain memory through avmshell's avmplus.Domain: the scratch memory, a
// ByteArray set as it, its least length, and lengths it cannot shrink to.
import avmplus.Domain;
import flash.utils.ByteArray;
import avm2.intrinsics.memory.*;
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e.errorID); }
}
trace(Domain.MIN_DOMAIN_MEMORY_LENGTH, Domain.currentDomain.domainMemory);
si32(0x01020304, 0);
trace("scratch", li32(0), li8(0), li16(2), li8(1023));
probe("scratch end", function():* { return li32(1021); });
var mem:ByteArray = new ByteArray();
mem.length = 100;
probe("too short", function():* { Domain.currentDomain.domainMemory = mem; });
mem.length = 2048;
Domain.currentDomain.domainMemory = mem;
trace(Domain.currentDomain.domainMemory == mem, li32(0));
si8(0x1ff, 10); si16(-1, 12); si32(-2, 16); sf32(0.5, 20); sf64(0.25, 24);
trace(li8(10), li16(12), li32(16), lf32(20), lf64(24), mem[10], mem[16]);
mem.position = 24;
mem.endian = "littleEndian";
trace(mem.readDouble());
mem[100] = 7;
trace(li8(100), sxi1(1), sxi8(0xff), sxi16(0x8000));
mem.length = 4096;
si8(5, 4000);
trace(li8(4000), mem[4000]);
// Each width at the end, one past it, and before 0; addresses and values
// that are not ints and numbers, converted in order.
probe("end 32", function():* { return li32(4092); });
probe("past 32", function():* { return li32(4093); });
probe("past 16", function():* { si16(1, 4095); });
probe("past 64", function():* { return lf64(4089); });
var neg:int = -1;
probe("negative", function():* { return li8(neg); });
probe("negative store", function():* { si8(1, neg); });
var fraction:Number = 1.5;
var text:String = "10";
si8(257.9, 30); si32(0xFFFFFFFF as uint, 32); sf32(true, 36);
trace("converted", li8(30), li32(32), lf32(36), li8(fraction), li8(text));
si8("3" as Object, 40);
trace("string value", li8(40));
var order:Array = [];
var at:Object = { valueOf: function():* { order.push("address"); return 44; } };
var what:Object = { valueOf: function():* { order.push("value"); return 9; } };
si8(what, at);
trace("order", order, li8(44));
probe("shrink", function():* { mem.length = 10; });
probe("past end", function():* { return li8(4096); });
probe("clear", function():* { mem.clear(); });
Domain.currentDomain.domainMemory = null;
trace(Domain.currentDomain.domainMemory, li32(0));
mem.length = 10;
trace(mem.length);
