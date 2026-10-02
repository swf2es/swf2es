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
