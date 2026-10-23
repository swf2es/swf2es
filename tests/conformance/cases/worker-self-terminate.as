// A worker that terminates itself while it holds a Mutex stops there: no
// catch around terminate runs, nor the code after it. It is terminated,
// the Mutex is free to take, and nothing more is written of what the
// Mutex guarded.
import flash.system.Worker;
import flash.system.WorkerDomain;
import flash.concurrent.Mutex;
import flash.utils.ByteArray;
import avmplus.System;

var me:Worker = Worker.current;
if (me.isPrimordial) {
    var m:Mutex = new Mutex();
    var log:ByteArray = new ByteArray();
    log.shareable = true;
    log.length = 16;
    var w:Worker = WorkerDomain.current.createWorkerFromPrimordial();
    w.setSharedProperty("m", m);
    w.setSharedProperty("log", log);
    w.start();
    var start:int = getTimer();
    while (log[0] != 1 && getTimer() - start < 5000) {
        System.sleep(1);
    }

    while (w.state != "terminated" && getTimer() - start < 5000) {
        System.sleep(1);
    }

    print("state " + w.state + " caught " + log[2]);
    var got:Boolean = m.tryLock();
    print("primordial got the mutex " + got);
    var a:int = log[1];
    System.sleep(100);
    var b:int = log[1];
    print("holder wrote after the primordial took it " + (b != a));
} else {
    var wm:Mutex = me.getSharedProperty("m");
    var l:ByteArray = me.getSharedProperty("log");
    wm.lock();
    l[0] = 1;
    try {
        me.terminate();
    } catch (e:Error) {
        l[2] = e.errorID == 1513 ? 1 : 2;
    }

    var t0:int = getTimer();
    while (getTimer() - t0 < 1000) {
        l[1] = (l[1] + 1) & 255;
        System.sleep(1);
    }
}
