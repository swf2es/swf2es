package {
  import flash.display.MovieClip;
  import flash.display3D.Context3D;
  import flash.events.Event;

  public class ContextStartup extends MovieClip {
    public var complete:Boolean = false;
    private var size:int = 0;

    public function ContextStartup() {
      addFrameScript(0, firstFrame);
      stage.stage3Ds[0].addEventListener(Event.CONTEXT3D_CREATE, created);
      stage.stage3Ds[0].requestContext3D("auto", "baseline");
      trace("contextstartup requested", stage.stage3Ds[0].context3D == null);
    }

    private function firstFrame():void {
      size = 96;
      trace("contextstartup first-frame");
    }

    private function created(event:Event):void {
      var context:Context3D = stage.stage3Ds[0].context3D;
      trace("contextstartup created", size);
      context.configureBackBuffer(size, size, 0, false);
      context.clear(0, 1, 0, 1);
      context.present();
      context.dispose(false);
      complete = true;
      trace("contextstartup complete");
    }
  }
}
