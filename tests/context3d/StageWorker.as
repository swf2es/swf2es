package {
  import flash.display.Sprite;
  import flash.display3D.Context3D;
  import flash.events.Event;
  import flash.system.MessageChannel;
  import flash.system.Worker;
  import flash.system.WorkerDomain;

  public class StageWorker extends Sprite {
    public var ready:Boolean = false;
    private var drew:Boolean = false;
    private var replied:Boolean = false;
    private var worker:Worker;
    private var channel:MessageChannel;

    public function StageWorker() {
      if (!Worker.current.isPrimordial) {
        channel = Worker.current.getSharedProperty("reply");
        channel.send(42);
        return;
      }

      stage.stage3Ds[0].addEventListener(Event.CONTEXT3D_CREATE, created);
      stage.stage3Ds[0].requestContext3D();
      worker = WorkerDomain.current.createWorker(loaderInfo.bytes);
      channel = worker.createMessageChannel(Worker.current);
      worker.setSharedProperty("reply", channel);
      channel.addEventListener(Event.CHANNEL_MESSAGE, received);
      worker.start();
    }

    private function created(e:Event):void {
      var context:Context3D = stage.stage3Ds[0].context3D;
      context.configureBackBuffer(32, 32, 0, false);
      context.clear(0, 1, 0, 1);
      context.present();
      drew = true;
      ready = drew && replied;
    }

    private function received(e:Event):void {
      if (channel.receive() !== 42) {
        throw new Error("wrong worker reply");
      }

      replied = true;
      worker.terminate();
      ready = drew && replied;
    }
  }
}
