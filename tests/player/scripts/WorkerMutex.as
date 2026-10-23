package {
  import flash.concurrent.Condition;
  import flash.concurrent.Mutex;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.system.MessageChannel;
  import flash.system.Worker;
  import flash.system.WorkerDomain;
  import flash.utils.ByteArray;

  // A Mutex and a Condition shared with two background workers: each adds
  // to one int of a shareable ByteArray 100 times, a read and a write that
  // only the mutex keeps whole, then counts itself done and notifies. The
  // primordial waits on the condition until both are done, each wait
  // letting go of the mutex, and a worker blocks in receive(true) until the
  // primordial sends it a message. Only the primordial traces, so that
  // Flash's timing of the workers does not change the trace.
  public class WorkerMutex extends Sprite {
    private var workers:Array = [];
    private var channels:Array = [];
    private var bytes:ByteArray;
    private var mutex:Mutex;
    private var condition:Condition;

    public function WorkerMutex() {
      if (Worker.current.isPrimordial) {
        primordial();
      } else {
        background();
      }
    }

    private function primordial():void {
      mutex = new Mutex();
      condition = new Condition(mutex);
      bytes = new ByteArray();
      bytes.shareable = true;
      bytes.length = 16;
      for (var i:int = 0; i < 2; i++) {
        var w:Worker = WorkerDomain.current.createWorker(loaderInfo.bytes);
        w.setSharedProperty("mutex", mutex);
        w.setSharedProperty("condition", condition);
        w.setSharedProperty("bytes", bytes);
        var channel:MessageChannel = Worker.current.createMessageChannel(w);
        w.setSharedProperty("channel", channel);
        channels.push(channel);
        workers.push(w);
      }

      var first:Worker = workers[0];
      trace("same " + (first.getSharedProperty("mutex") == mutex) + " " + (first.getSharedProperty("condition") == condition));
      for each (var started:Worker in workers) {
        started.start();
      }

      addEventListener(Event.ENTER_FRAME, check);
    }

    private function check(e:Event):void {
      removeEventListener(Event.ENTER_FRAME, check);
      for each (var channel:MessageChannel in channels) {
        channel.send("go");
      }

      mutex.lock();
      var waits:int = 0;
      while (bytes[4] < 2 && waits < 1000) {
        condition.wait(10);
        waits++;
      }

      trace("counted " + bytes.readUnsignedInt() + " done " + bytes[4] + " seen " + bytes[5] + " " + bytes[6]);
      trace("timed out " + condition.wait(1));
      mutex.unlock();
      trace("free " + mutex.tryLock());
      mutex.unlock();
      for each (var w:Worker in workers) {
        w.terminate();
      }
    }

    private function background():void {
      var m:Mutex = Worker.current.getSharedProperty("mutex");
      var c:Condition = Worker.current.getSharedProperty("condition");
      var b:ByteArray = Worker.current.getSharedProperty("bytes");
      var channel:MessageChannel = Worker.current.getSharedProperty("channel");
      var message:* = channel.receive(true);
      for (var n:int = 0; n < 100; n++) {
        m.lock();
        b.position = 0;
        var count:uint = b.readUnsignedInt();
        b.position = 0;
        b.writeUnsignedInt(count + 1);
        m.unlock();
      }

      m.lock();
      // Its own object for each, and the condition's mutex the same.
      b[5 + b[4]] = message == "go" && c.mutex == m && Worker.current.getSharedProperty("mutex") == m ? 1 : 0;
      b[4]++;
      c.notify();
      m.unlock();
    }
  }
}
