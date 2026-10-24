package {
  import flash.display.Sprite;
  import flash.display3D.Context3D;
  import flash.events.Event;
  import flash.events.ErrorEvent;
  import flash.system.MessageChannel;
  import flash.system.Worker;
  import flash.system.WorkerDomain;

  public class SiteStage3D extends Sprite {
    private var drew:Boolean = false;
    private var replied:Boolean = false;
    private var ready:Boolean = false;
    private var worker:Worker;
    private var channel:MessageChannel;

    public function SiteStage3D() {
      if (!Worker.current.isPrimordial) {
        channel = Worker.current.getSharedProperty("reply");
        channel.send(42);
        return;
      }

      stage.stage3Ds[0].addEventListener(ErrorEvent.ERROR, function(event:ErrorEvent):void {
        trace("site-stage3d unavailable " + event.errorID);
      });
      stage.stage3Ds[0].addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        var context:Context3D = stage.stage3Ds[0].context3D;
        context.configureBackBuffer(32, 32, 0, false);
        context.clear(0, 1, 0, 1);
        context.present();
        drew = true;
        checkReady();
      });
      stage.stage3Ds[0].requestContext3D();
      worker = WorkerDomain.current.createWorker(loaderInfo.bytes);
      channel = worker.createMessageChannel(Worker.current);
      worker.setSharedProperty("reply", channel);
      channel.addEventListener(Event.CHANNEL_MESSAGE, function(event:Event):void {
        if (channel.receive() !== 42) {
          throw new Error("wrong worker reply");
        }

        trace("site-stage3d worker replied");
        worker.terminate();
        replied = true;
        checkReady();
      });
      worker.start();
    }

    private function checkReady():void {
      if (drew && replied && !ready) {
        ready = true;
        trace("site-stage3d ready");
      }
    }
  }
}
