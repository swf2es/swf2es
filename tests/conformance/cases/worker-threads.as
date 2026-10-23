// avmshell's background workers on threads of their own: a worker's
// lifecycle (new, running, terminated; start once, by its parent;
// terminate true only while it runs), listWorkers listing those running,
// and shared properties crossing threads as avmplus' ChannelItem copies
// them, seen at once while the other side waits in System.sleep. A
// worker's properties are let go when it ends. The background workers run
// this same code, createWorkerFromPrimordial's, and print nothing.
import flash.system.Worker;
import flash.system.WorkerDomain;
import flash.utils.ByteArray;
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

function primordialOf(list:Vector.<Worker>):Worker {
    for (var i:int = 0; i < list.length; i++) {
        if (list[i].isPrimordial) {
            return list[i];
        }
    }

    return null;
}

var me:Worker = Worker.current;
if (me.isPrimordial) {
    var w:Worker = WorkerDomain.current.createWorkerFromPrimordial();
    print("made " + w.state + " " + w.isPrimordial + " " + me.isParentOf(w) + " " + w.isParentOf(me));
    print("listed " + WorkerDomain.current.listWorkers().length);
    print("terminate new " + w.terminate() + " " + w.state);

    w.setSharedProperty("in", {a: 1, b: [2, 3]});
    var bytes:ByteArray = new ByteArray();
    bytes.writeUTF("hello");
    w.setSharedProperty("bytes", bytes);
    w.setSharedProperty("zero", -0);
    w.start();
    try {
        w.start();
    } catch (e:Error) {
        print("start again " + e);
    }

    print("answered " + waitFor(function():Boolean { return me.getSharedProperty("out") !== undefined; }));
    var out:Object = me.getSharedProperty("out");
    print("out " + out.sum + " " + out.state + " " + out.primordial + " " + out.bytes + " " + out.same + " " + out.zero + " " + out.parent);
    print("ended " + waitFor(function():Boolean { return w.state == "terminated"; }) + " " + w.state);
    print("let go " + w.getSharedProperty("in") + " " + w.getSharedProperty("bytes"));
    print("terminate ended " + w.terminate());

    var spinner:Worker = WorkerDomain.current.createWorkerFromPrimordial();
    spinner.setSharedProperty("spin", true);
    spinner.start();
    print("running " + waitFor(function():Boolean { return spinner.state == "running"; }) + " " + spinner.state);
    print("listed " + WorkerDomain.current.listWorkers().length);
    print("terminate running " + spinner.terminate());
    // avmshell interrupts a worker only where its interrupts are on, which
    // the oracle's are not: told to stop, it ends by itself.
    spinner.setSharedProperty("stop", true);
    print("stopped " + waitFor(function():Boolean { return spinner.state == "terminated"; }) + " " + spinner.state);
    print("listed " + WorkerDomain.current.listWorkers().length);
    print("terminate again " + spinner.terminate());
} else if (me.getSharedProperty("spin")) {
    while (!me.getSharedProperty("stop")) {
        System.sleep(5);
    }
} else {
    var input:Object = me.getSharedProperty("in");
    var b:ByteArray = me.getSharedProperty("bytes");
    var primordial:Worker = primordialOf(WorkerDomain.current.listWorkers());
    primordial.setSharedProperty("out", {
        sum: input.a + input.b[0] + input.b[1],
        state: me.state,
        primordial: me.isPrimordial,
        bytes: b.readUTF(),
        same: me.getSharedProperty("bytes") == b,
        zero: 1 / me.getSharedProperty("zero"),
        parent: primordial.isParentOf(me)
    });
}
