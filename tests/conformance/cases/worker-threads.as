// avmshell's background workers on threads of their own: a worker's
// lifecycle (new, running, terminated; start once, by its parent;
// terminate true only while it runs), listWorkers listing those running,
// and shared properties crossing threads as avmplus' ChannelItem copies
// them, seen at once while the other side waits in System.sleep. A
// worker's properties are let go when it ends, and the workers it started
// run on. The background workers run this same code,
// createWorkerFromPrimordial's, and print nothing. A running worker is not
// terminated here: the oracle's avmshell runs without interrupts, and
// waits for such a worker at times for ever (the CLI's unit test has it).
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

    // A worker that ends leaves the worker it started running.
    var parent:Worker = WorkerDomain.current.createWorkerFromPrimordial();
    parent.setSharedProperty("role", "parent");
    parent.start();
    print("parent ended " + waitFor(function():Boolean { return parent.state == "terminated"; }) + " " + parent.state);
    print("grandchild running " + waitFor(function():Boolean { return WorkerDomain.current.listWorkers().length == 2; }));
    var grandchild:Worker = null;
    var listed:Vector.<Worker> = WorkerDomain.current.listWorkers();
    for (var i:int = 0; i < listed.length; i++) {
        if (!listed[i].isPrimordial) {
            grandchild = listed[i];
        }
    }

    print("grandchild " + grandchild.isPrimordial + " " + grandchild.state + " " + parent.isParentOf(grandchild) + " " + me.isParentOf(grandchild));
    me.setSharedProperty("stop", true);
    print("grandchild ended " + waitFor(function():Boolean { return grandchild.state == "terminated"; }) + " " + grandchild.state);
    print("listed " + WorkerDomain.current.listWorkers().length);
} else if (me.getSharedProperty("role") == "parent") {
    var child:Worker = WorkerDomain.current.createWorkerFromPrimordial();
    child.setSharedProperty("role", "grandchild");
    child.start();
} else if (me.getSharedProperty("role") == "grandchild") {
    var top:Worker = primordialOf(WorkerDomain.current.listWorkers());
    while (!top.getSharedProperty("stop")) {
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
