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
probe("shrink", function():* { mem.length = 10; });
probe("past end", function():* { return li8(4096); });
probe("clear", function():* { mem.clear(); });
Domain.currentDomain.domainMemory = null;
trace(Domain.currentDomain.domainMemory, li32(0));
mem.length = 10;
trace(mem.length);
