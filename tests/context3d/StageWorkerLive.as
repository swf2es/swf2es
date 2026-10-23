package {
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.events.Event;
  import flash.events.ErrorEvent;
  import flash.system.MessageChannel;
  import flash.system.Worker;
  import flash.system.WorkerDomain;
  import flash.utils.setInterval;

  public class StageWorkerLive extends Sprite {
    public var ready:Boolean = false;
    public var replies:int = 0;
    private var drew:Boolean = false;
    private var worker:Worker;
    private var channel:MessageChannel;

    public function StageWorkerLive() {
      if (!Worker.current.isPrimordial) {
        channel = Worker.current.getSharedProperty("reply");
        var slot:Stage3D = stage ? stage.stage3Ds[0] : new Stage3D();
        slot.addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
          throw new Error("background worker received a Stage3D host");
        });
        slot.addEventListener(ErrorEvent.ERROR, function(e:ErrorEvent):void {
          if (e.errorID != 3702 || slot.context3D !== null) {
            throw new Error("wrong worker Stage3D fallback");
          }
          channel.send(42);
          setInterval(function():void { channel.send(42); }, 50);
        });
        slot.requestContext3D();
        return;
      }

      stage.stage3Ds[0].addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
        var context:* = stage.stage3Ds[0].context3D;
        context.configureBackBuffer(32, 32, 0, false);
        context.clear(0, 1, 0, 1);
        context.present();
        drew = true;
        ready = drew && replies >= 2;
      });
      stage.stage3Ds[0].requestContext3D();
      worker = WorkerDomain.current.createWorker(loaderInfo.bytes);
      channel = worker.createMessageChannel(Worker.current);
      worker.setSharedProperty("reply", channel);
      channel.addEventListener(Event.CHANNEL_MESSAGE, function(e:Event):void {
        while (channel.messageAvailable) {
          if (channel.receive() !== 42) { throw new Error("wrong worker reply"); }
          replies++;
        }
        ready = drew && replies >= 2;
      });
      worker.start();
    }

    public function get workerState():String { return worker.state; }
  }
}
