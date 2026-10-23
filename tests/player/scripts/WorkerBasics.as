package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.system.MessageChannel;
  import flash.system.Worker;
  import flash.system.WorkerDomain;
  import flash.utils.ByteArray;
  import flash.utils.getQualifiedClassName;

  // A background worker started from the SWF's own bytes: what each side
  // sees of the other's shared properties, messages both ways over two
  // channels, and the worker's states. Only the primordial traces, and only
  // what arrives in an order of its own making, so that Flash's timing of
  // the worker does not change the trace.
  public class WorkerBasics extends Sprite {
    private var worker:Worker;
    private var toBg:MessageChannel;
    private var fromBg:MessageChannel;
    private var states:Array = [];
    private var left:int = -1;

    public function WorkerBasics() {
      if (Worker.current.isPrimordial) {
        primordial();
      } else {
        background();
      }
    }

    private static function describe(e:Error):String {
      return getQualifiedClassName(e) + " " + e.errorID;
    }

    private function primordial():void {
      trace("supported " + Worker.isSupported + " " + WorkerDomain.isSupported);
      trace("current " + Worker.current.isPrimordial + " " + Worker.current.state);
      worker = WorkerDomain.current.createWorker(loaderInfo.bytes);
      trace("created " + worker.isPrimordial + " " + worker.state + " " + (worker == Worker.current));
      toBg = Worker.current.createMessageChannel(worker);
      fromBg = worker.createMessageChannel(Worker.current);
      trace("channel " + toBg.state + " " + toBg.messageAvailable + " " + fromBg.state);
      try {
        trace("receive on sender " + toBg.receive());
      } catch (e:Error) {
        trace("receive on sender " + describe(e));
      }

      try {
        fromBg.send("x");
        trace("send on receiver");
      } catch (e:Error) {
        trace("send on receiver " + describe(e));
      }

      trace("receive nothing " + fromBg.receive() + " " + fromBg.messageAvailable);
      worker.setSharedProperty("toBg", toBg);
      worker.setSharedProperty("fromBg", fromBg);
      var o:Object = {a: 1, b: [2, "three"]};
      worker.setSharedProperty("object", o);
      o.a = 5;
      var copy:Object = worker.getSharedProperty("object");
      trace("shared copy " + (copy == o) + " " + copy.a + " " + copy.b[1] + " " + (copy == worker.getSharedProperty("object")));
      trace("shared channel " + (worker.getSharedProperty("toBg") == toBg));
      var bytes:ByteArray = new ByteArray();
      bytes.writeUTFBytes("bytes");
      worker.setSharedProperty("bytes", bytes);
      var bytesCopy:ByteArray = worker.getSharedProperty("bytes");
      trace("shared bytes " + (bytesCopy == bytes) + " " + bytesCopy.length + " " + bytesCopy.position + " " + bytesCopy.toString());
      trace("missing " + worker.getSharedProperty("missing"));
      worker.setSharedProperty("gone", 1);
      worker.setSharedProperty("gone", undefined);
      trace("undefined " + worker.getSharedProperty("gone"));
      worker.setSharedProperty("null", null);
      trace("null " + worker.getSharedProperty("null"));
      worker.setSharedProperty("int", 7);
      worker.setSharedProperty("number", 0.5);
      worker.setSharedProperty("string", "text");
      trace("primitives " + worker.getSharedProperty("int") + " " + worker.getSharedProperty("number") + " " + worker.getSharedProperty("string"));
      trace("primordial shared " + Worker.current.getSharedProperty("object"));
      trace("listed " + WorkerDomain.current.listWorkers().length);
      worker.addEventListener(Event.WORKER_STATE, function(e:Event):void {
        states.push(worker.state);
      });
      fromBg.addEventListener(Event.CHANNEL_MESSAGE, received);
      toBg.send("hello");
      toBg.send({n: 42});
      trace("before start " + worker.state + " " + toBg.messageAvailable);
      worker.start();
      try {
        worker.start();
        trace("started twice");
      } catch (e:Error) {
        trace("started twice " + describe(e));
      }

      try {
        Worker.current.terminate();
        trace("terminate primordial");
      } catch (e:Error) {
        trace("terminate primordial " + describe(e));
      }

      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function received(e:Event):void {
      while (fromBg.messageAvailable) {
        var message:* = fromBg.receive();
        trace("message " + message);
        if (message == "echo n=42") {
          trace("set by worker " + worker.getSharedProperty("fromWorker"));
          trace("terminate " + worker.terminate());
          trace("terminate again " + worker.terminate());
          left = 10;
        }
      }
    }

    private function frame(e:Event):void {
      if (left > 0 && --left == 0) {
        trace("states " + states.join(" ") + ", now " + worker.state);
        trace("listed " + WorkerDomain.current.listWorkers().length);
        closing();
      } else if (left < 0 && left > -100 && --left == -6) {
        trace("self events " + selfEvents.join(", "));
        removeEventListener(Event.ENTER_FRAME, frame);
      }
    }

    private var selfEvents:Array = [];

    // A channel from the primordial to itself, closed with a message queued.
    private function closing():void {
      var self:MessageChannel = Worker.current.createMessageChannel(Worker.current);
      self.addEventListener(Event.CHANNEL_STATE, function(e:Event):void {
        selfEvents.push("state " + self.state);
      });
      self.addEventListener(Event.CHANNEL_MESSAGE, function(e:Event):void {
        selfEvents.push("message " + self.messageAvailable);
      });
      self.send(1);
      self.send(2);
      trace("self " + self.messageAvailable + " " + self.receive() + " " + self);
      self.close();
      trace("closing " + self.state + " " + self.messageAvailable);
      try {
        self.send(3);
        trace("sent after close");
      } catch (e:Error) {
        trace("send after close " + describe(e));
      }

      trace("receive after close " + self.receive() + " " + self.state);
      try {
        trace("receive again " + self.receive() + " " + self.state);
      } catch (e:Error) {
        trace("receive again " + describe(e));
      }

      try {
        self.close();
        trace("closed again " + self.state);
      } catch (e:Error) {
        trace("closed again " + describe(e));
      }

      left = -1;
    }

    private function background():void {
      var me:Worker = Worker.current;
      var to:MessageChannel = me.getSharedProperty("toBg");
      var from:MessageChannel = me.getSharedProperty("fromBg");
      var o:Object = me.getSharedProperty("object");
      var bytes:ByteArray = me.getSharedProperty("bytes");
      me.setSharedProperty("fromWorker", "worker's");
      from.send("background " + me.isPrimordial + " " + me.state + " " + o.a + " " + o.b[1] + " " + bytes.toString() + " " + (Worker.current == me));
      var drain:Function = function(e:Event = null):void {
        while (to.messageAvailable) {
          var m:* = to.receive();
          from.send(m is String ? "echo " + m : "echo n=" + m.n);
        }
      };
      to.addEventListener(Event.CHANNEL_MESSAGE, drain);
      drain();
    }
  }
}
