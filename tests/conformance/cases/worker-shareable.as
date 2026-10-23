// A shareable ByteArray across avmshell's workers, its memory shared as
// avmplus' ByteArrays share one Buffer: once shareable always so, one
// object a worker for it, its bytes and its length seen at once by the
// other worker while this one waits in System.sleep, grown in place by
// either (its length set, written past, swapped with
// atomicCompareAndSwapLength), the atomics on it, domain memory over it on
// both sides, compressed and cleared for both; and one a worker made
// shareable, set on the primordial. The background worker runs
// this same code, createWorkerFromPrimordial's, and prints nothing.
import flash.system.Worker;
import flash.system.WorkerDomain;
import flash.utils.ByteArray;
import avmplus.Domain;
import avmplus.System;
import avm2.intrinsics.memory.*;

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

// The step both sides are at: the primordial's at byte 0, the worker's at 4.
function step(ba:ByteArray, at:int):int {
    return ba.atomicCompareAndSwapIntAt(at, -1, -1);
}

function next(ba:ByteArray, at:int):void {
    var now:int = step(ba, at);
    ba.atomicCompareAndSwapIntAt(at, now, now + 1);
}

var me:Worker = Worker.current;
if (me.isPrimordial) {
    var ba:ByteArray = new ByteArray();
    ba.endian = "littleEndian";
    ba.length = 2048;
    print("shareable " + ba.shareable);
    ba.shareable = true;
    ba.shareable = false;
    print("still " + ba.shareable);
    ba.position = 16;
    ba.writeUTFBytes("hello");

    var plain:ByteArray = new ByteArray();
    plain.writeUTFBytes("copy");

    var w:Worker = WorkerDomain.current.createWorkerFromPrimordial();
    w.setSharedProperty("ba", ba);
    w.setSharedProperty("plain", plain);
    print("same here " + (w.getSharedProperty("ba") == ba) + " " + (w.getSharedProperty("plain") == plain));
    w.start();

    // 1: the worker read "hello", wrote after it and grew the length.
    print("1 " + waitFor(function():Boolean { return step(ba, 4) == 1; }));
    ba.position = 16;
    print("seen " + ba.length + " " + ba.readUTFBytes(11) + " " + ba[3000] + " " + plain.length);

    // Domain memory over it here, the worker's over it there.
    Domain.currentDomain.domainMemory = ba;
    si32(1234, 64);
    next(ba, 0);
    print("2 " + waitFor(function():Boolean { return step(ba, 4) == 2; }));
    print("memory " + li32(68) + " " + li32(5000) + " " + ba.length);
    Domain.currentDomain.domainMemory = null;

    // The worker grows it with atomicCompareAndSwapLength, a second swap from the old length fails.
    next(ba, 0);
    print("3 " + waitFor(function():Boolean { return step(ba, 4) == 3; }));
    print("swapped " + ba.length + " " + ba.atomicCompareAndSwapLength(6000, 7000) + " " + ba.length);

    // Compressed here, seen compressed there; the worker answers with its uncompress.
    ba.length = 1000;
    ba.compress();
    print("compressed " + (ba.length < 1000) + " " + ba.shareable);
    print("4 " + waitFor(function():Boolean { return ba.length == 1000; }));
    print("uncompressed " + ba.length + " " + ba[0] + " " + ba[4]);

    // One the worker made shareable and set here, written both ways.
    print("back " + waitFor(function():Boolean { return me.getSharedProperty("back") !== undefined; }));
    var back:ByteArray = me.getSharedProperty("back");
    print("back " + back.length + " " + back[0] + " " + back.shareable + " " + (me.getSharedProperty("back") == back));
    back[1] = 8;

    // Cleared there, empty here.
    ba.atomicCompareAndSwapIntAt(0, 2, 5);
    print("5 " + waitFor(function():Boolean { return ba.length == 0; }));
    print("cleared " + ba.length + " " + ba.bytesAvailable + " " + ba.shareable);
    print("ended " + waitFor(function():Boolean { return w.state == "terminated"; }));
} else {
    var shared:ByteArray = me.getSharedProperty("ba");
    var copied:ByteArray = me.getSharedProperty("plain");
    shared.endian = "littleEndian";
    var top:Worker = primordialOf(WorkerDomain.current.listWorkers());
    var mine:Boolean = me.getSharedProperty("ba") == shared && shared.shareable;
    copied.length = 0;

    shared.position = 21;
    shared.writeUTFBytes(mine ? " there" : " other");
    shared[3000] = 7;
    shared.atomicCompareAndSwapIntAt(4, 0, 1);

    waitFor(function():Boolean { return step(shared, 0) == 1; });
    Domain.currentDomain.domainMemory = shared;
    si32(li32(64) + 1, 68);
    shared.length = 6000;
    si32(42, 5000);
    shared.atomicCompareAndSwapIntAt(4, 1, 2);

    waitFor(function():Boolean { return step(shared, 0) == 2; });
    Domain.currentDomain.domainMemory = null;
    shared.atomicCompareAndSwapLength(6000, 8000);
    shared.atomicCompareAndSwapIntAt(4, 2, 3);

    waitFor(function():Boolean { return shared.length < 1000 && shared.length > 0; });
    shared.uncompress();

    var back:ByteArray = new ByteArray();
    back.shareable = true;
    back[0] = 9;
    top.setSharedProperty("back", back);
    waitFor(function():Boolean { return back[1] == 8; });

    waitFor(function():Boolean { return step(shared, 0) == 5; });
    shared.clear();
}
