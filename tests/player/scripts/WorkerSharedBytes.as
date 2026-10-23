package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.system.Worker;
  import flash.system.WorkerDomain;
  import flash.utils.ByteArray;

  // One shareable ByteArray, two background workers writing it: each
  // counts to 100 in the same int with atomicCompareAndSwapIntAt, marks
  // its own byte, and grows the length with atomicCompareAndSwapLength,
  // which only one of them wins. The primordial reads the bytes each frame
  // with no message from either, and traces once it sees all of it, so that
  // Flash's timing of the workers does not change the trace.
  public class WorkerSharedBytes extends Sprite {
    private var bytes:ByteArray;
    private var workers:Array = [];
    private var done:Boolean = false;

    public function WorkerSharedBytes() {
      if (Worker.current.isPrimordial) {
        primordial();
      } else {
        background();
      }
    }

    private static function load(b:ByteArray, at:int):int {
      return b.atomicCompareAndSwapIntAt(at, -1, -1);
    }

    private function primordial():void {
      bytes = new ByteArray();
      bytes.length = 16;
      trace("shareable " + bytes.shareable);
      bytes.shareable = true;
      bytes.shareable = false;
      trace("shareable " + bytes.shareable);
      for (var i:int = 0; i < 2; i++) {
        var w:Worker = WorkerDomain.current.createWorker(loaderInfo.bytes);
        w.setSharedProperty("bytes", bytes);
        w.setSharedProperty("index", i);
        trace("same " + (w.getSharedProperty("bytes") == bytes) + " " + bytes.length);
        workers.push(w);
      }

      // Written after the set, before start: the workers see it in the memory they share.
      bytes[8] = 5;
      for each (var started:Worker in workers) {
        started.start();
      }

      addEventListener(Event.ENTER_FRAME, check);
    }

    private function check(e:Event):void {
      if (done) {
        return;
      }

      var count:int = load(bytes, 0);
      if (count == 200 && bytes.length == 64 && bytes[4] == 6 && bytes[5] == 7) {
        done = true;
        trace("seen " + count + " " + bytes.length + " " + bytes[4] + " " + bytes[5] + " " + bytes[6] + " " + bytes[7] + " " + bytes[63]);
        for each (var w:Worker in workers) {
          w.terminate();
        }
      }
    }

    private function background():void {
      var b:ByteArray = Worker.current.getSharedProperty("bytes");
      var index:int = Worker.current.getSharedProperty("index");
      for (var n:int = 0; n < 100; n++) {
        var old:int;
        do {
          old = load(b, 0);
        } while (b.atomicCompareAndSwapIntAt(0, old, old + 1) != old);
      }

      // Its own object for the property each time, shareable as it was set.
      b[6 + index] = Worker.current.getSharedProperty("bytes") == b && b.shareable ? 1 : 0;
      b.atomicCompareAndSwapLength(16, 64);
      b[63] = 9;
      b[4 + index] = b[8] + 1 + index;
    }
  }
}
