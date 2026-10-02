// flash.concurrent on avmshell's one worker, the primordial: Mutex and
// Condition, ByteArray's atomic operations and the domain memory's compare
// and swap, as Crossbridge uses them whether or not it starts workers. The
// domain memory's length swapped below its least is left out: the oracle's
// avmshell allows it, and later avmplus, as swf2es, refuses it (1506).
import avmplus.Domain;
import flash.concurrent.Condition;
import flash.concurrent.Mutex;
import flash.system.Worker;
import flash.utils.ByteArray;
import avm2.intrinsics.memory.*;
function probe(name:String, f:Function):void {
  try { trace(name, f()); } catch (e:Error) { trace(name, e.errorID, e is ArgumentError, e is RangeError); }
}

trace(Mutex.isSupported, Condition.isSupported);
var m:Mutex = new Mutex();
probe("unlock unheld", function():* { m.unlock(); });
m.lock();
trace("tryLock while held", m.tryLock());
m.unlock();
m.unlock();
probe("unlock again", function():* { m.unlock(); });

var c:Condition = new Condition(m);
trace(c.mutex == m);
probe("null mutex", function():* { return new Condition(null); });
probe("notify unheld", function():* { c.notify(); });
probe("notifyAll unheld", function():* { c.notifyAll(); });
probe("wait unheld", function():* { return c.wait(0); });
m.lock();
probe("bad timeout", function():* { return c.wait(-2); });
c.notify();
c.notifyAll();
trace("wait", c.wait(1), c.wait(0), c.wait(0.5));
trace("still held", m.tryLock());
m.unlock();
m.unlock();

var w:Worker = Worker.current;
trace(w == Worker.current, w.isPrimordial, w.state);
trace(w.getSharedProperty("missing"));
w.setSharedProperty("n", 42);
w.setSharedProperty("o", m);
trace(w.getSharedProperty("n"), w.getSharedProperty("o") == m);

var b:ByteArray = new ByteArray();
b.length = 16;
b.endian = "littleEndian";
b.position = 4;
b.writeInt(7);
trace("cas int", b.atomicCompareAndSwapIntAt(4, 7, 9), b.atomicCompareAndSwapIntAt(4, 7, 11));
b.position = 4;
trace(b.readInt());
probe("cas unaligned", function():* { return b.atomicCompareAndSwapIntAt(2, 0, 1); });
probe("cas past end", function():* { return b.atomicCompareAndSwapIntAt(16, 0, 1); });
probe("cas last", function():* { return b.atomicCompareAndSwapIntAt(12, 0, 1); });
trace("cas length", b.atomicCompareAndSwapLength(16, 32), b.length);
trace("cas length missed", b.atomicCompareAndSwapLength(16, 64), b.length);
trace("cas length shorter", b.atomicCompareAndSwapLength(32, 8), b.length, b.position);

var mem:ByteArray = new ByteArray();
mem.length = 2048;
Domain.currentDomain.domainMemory = mem;
si32(5, 8);
trace("casi32", casi32(8, 5, 6), casi32(8, 5, 7), li32(8));
probe("casi32 unaligned", function():* { return casi32(9, 0, 1); });
probe("casi32 past end", function():* { return casi32(2048, 0, 1); });
probe("casi32 negative", function():* { return casi32(-4, 0, 1); });
mfence();
trace("domain cas", mem.atomicCompareAndSwapLength(2048, 4096), mem.length);
si32(3, 4092);
trace(li32(4092), casi32(4092, 3, 4), li32(4092));
