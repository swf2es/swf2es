// flash.concurrent's Mutex and Condition across avmshell's workers: each
// crosses by reference, one object a worker, a Condition's mutex its
// Mutex there too; a notify picks the waiters in the order they came,
// which take the mutex again in that order; wait gives false when
// notified and true when its time runs out, a notify with no waiter is
// lost, and a wait lets go of a mutex however many times it was held. A
// worker terminated while it holds a mutex lets go of it. (A waiter
// terminated is not here: the oracle's avmshell reports it running, and a
// notify then reaches none of the others; swf2es passes over it, see
// tests/unit/runtime/sync.test.ts.) Only the primordial prints;
// the workers write what they saw into a shareable ByteArray.
import flash.system.Worker;
import flash.system.WorkerDomain;
import flash.concurrent.Mutex;
import flash.concurrent.Condition;
import flash.utils.ByteArray;
import avmplus.System;

function primordialOf(list:Vector.<Worker>):Worker {
    for (var i:int = 0; i < list.length; i++) {
        if (list[i].isPrimordial) {
            return list[i];
        }
    }

    return null;
}

function waitFor(done:Function):Boolean {
    var start:int = getTimer();
    while (!done()) {
        if (getTimer() - start > 10000) {
            return false;
        }

        System.sleep(2);
    }

    return true;
}

var me:Worker = Worker.current;
if (me.isPrimordial) {
    var m:Mutex = new Mutex();
    var c:Condition = new Condition(m);
    var log:ByteArray = new ByteArray();
    log.shareable = true;
    log.length = 64;

    // Four waiters, each waiting before the next comes.
    var ws:Array = [];
    for (var i:int = 0; i < 4; i++) {
        var w:Worker = WorkerDomain.current.createWorkerFromPrimordial();
        w.setSharedProperty("m", m);
        w.setSharedProperty("c", c);
        w.setSharedProperty("log", log);
        w.setSharedProperty("n", i);
        w.setSharedProperty("mode", "wait");
        if (i == 0) {
            print("same " + (w.getSharedProperty("m") === m) + " " + (w.getSharedProperty("c") === c));
        }

        w.start();
        ws.push(w);
        // It holds the mutex until its wait lets go of it.
        waitFor(function():Boolean { return log[32 + i] == 1; });
        m.lock();
        m.unlock();
    }

    print("back " + (me.getSharedProperty("mback") === m) + " " + (me.getSharedProperty("cback") === c));
    m.lock();
    c.notify();
    c.notify();
    m.unlock();
    waitFor(function():Boolean { return log[48] == 2; });
    m.lock();
    c.notifyAll();
    m.unlock();
    waitFor(function():Boolean { return log[48] == 4; });
    var order:Array = [];
    for (i = 0; i < 4; i++) {
        order.push(log[i]);
    }

    print("order " + order.join(","));

    // No waiter: the notify is lost, and the wait runs its time out.
    m.lock();
    m.lock();
    c.notify();
    c.notifyAll();
    print("timed out " + c.wait(20));
    m.unlock();
    m.unlock();
    try {
        m.unlock();
    } catch (e:Error) {
        print("unlocked once too often " + e.errorID);
    }

    // A worker terminated while it holds the mutex lets go of it.
    var holder:Worker = WorkerDomain.current.createWorkerFromPrimordial();
    holder.setSharedProperty("m", m);
    holder.setSharedProperty("log", log);
    holder.setSharedProperty("mode", "hold");
    holder.start();
    waitFor(function():Boolean { return log[40] == 1; });
    print("held by a worker " + m.tryLock());
    print("terminate " + holder.terminate());
    print("let go " + waitFor(function():Boolean { return m.tryLock(); }));
    m.unlock();
} else {
    var wm:Mutex = me.getSharedProperty("m");
    var l:ByteArray = me.getSharedProperty("log");
    if (me.getSharedProperty("mode") == "hold") {
        wm.lock();
        l[40] = 1;
        // Blocked, which a terminate interrupts, holding wm.
        var own:Condition = new Condition(new Mutex());
        own.mutex.lock();
        own.wait();
    } else {
        var wc:Condition = me.getSharedProperty("c");
        var n:int = me.getSharedProperty("n");
        wm.lock();
        if (n == 0) {
            var p:Worker = primordialOf(WorkerDomain.current.listWorkers());
            p.setSharedProperty("mback", wm);
            p.setSharedProperty("cback", wc);
        }

        l[32 + n] = 1;
        var timedOut:Boolean = wc.wait();
        // Under the mutex: the order they took it again in.
        var at:int = l[48];
        l[at] = 10 + n + (timedOut ? 100 : 0) + (wc.mutex === wm ? 0 : 50);
        l[48] = at + 1;
        wm.unlock();
    }
}
