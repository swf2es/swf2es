import flash.system.Worker;
import flash.system.WorkerDomain;
import avmplus.System;

function waitFor(done:Function):Boolean {
    var start:int = getTimer();
    while (!done()) {
        if (getTimer() - start > 20000) {
            return false;
        }

        System.sleep(5);
    }

    return true;
}

if (Worker.current.isPrimordial) {
    var w:Worker = WorkerDomain.current.createWorkerFromPrimordial();
    w.start();
    print("spinning " + waitFor(function():Boolean { return w.getSharedProperty("spinning") === true; }));
    print("listed " + WorkerDomain.current.listWorkers().length + " " + w.state);
    print("terminate " + w.terminate() + " " + w.state);
    print("listed " + WorkerDomain.current.listWorkers().length);
    print("terminate again " + w.terminate());
} else {
    Worker.current.setSharedProperty("spinning", true);
    while (true) {
    }
}
