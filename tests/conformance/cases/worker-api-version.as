// avmshell: -api AIR_3_4
// A background worker runs at the primordial's API version, in its series:
// both see AIR's names and report AIR 3.4's version, the first at which
// avmshell's Worker is AIR's. The worker's goes back through shared
// bytes, printed by the primordial, so that the lines come in one order.
import flash.system.Worker;
import flash.system.WorkerDomain;
import flash.utils.ByteArray;
import avmplus.System;
import avmshell.*;

function seesAir():Boolean {
    try {
        return public_var_AIR_1_0;
    } catch (e:Error) {
    }

    return false;
}

var me:Worker = Worker.current;
if (me.isPrimordial) {
    var log:ByteArray = new ByteArray();
    log.shareable = true;
    log.length = 3;
    var w:Worker = WorkerDomain.current.createWorkerFromPrimordial();
    w.setSharedProperty("log", log);
    w.start();
    var start:int = getTimer();
    while (log[0] != 1 && getTimer() - start < 5000) {
        System.sleep(1);
    }

    print("primordial " + System.apiVersion + " " + seesAir());
    print("worker " + log[1] + " " + (log[2] == 1));
} else {
    var l:ByteArray = me.getSharedProperty("log");
    l[1] = System.apiVersion;
    l[2] = seesAir() ? 1 : 0;
    l[0] = 1;
}
