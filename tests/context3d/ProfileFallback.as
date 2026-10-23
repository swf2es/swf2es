package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.ErrorEvent;

  public class ProfileFallback extends Sprite {
    public var ready:Boolean = false;
    public var fallback:String = "";
    private var returned:Boolean = false;

    public function ProfileFallback() {
      var slot:* = stage.stage3Ds[0];
      slot.addEventListener(ErrorEvent.ERROR, function(e:ErrorEvent):void {
        fallback = e.errorID + "," + returned + "," + (slot.context3D === null) + "," + e.bubbles + "," + e.cancelable;
        slot.requestContext3D("auto", "baseline");
      });
      slot.addEventListener(Event.CONTEXT3D_CREATE, function(e:Event):void {
        slot.context3D.configureBackBuffer(32, 32, 0, false);
        slot.context3D.clear(0, 1, 0, 1);
        slot.context3D.present();
        ready = true;
      });
      slot.requestContext3D("auto", "baselineConstrained");
      returned = true;
    }
  }
}
