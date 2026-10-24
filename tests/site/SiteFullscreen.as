package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.events.MouseEvent;

  public class SiteFullscreen extends Sprite {
    public function SiteFullscreen() {
      stage.scaleMode = "noScale";
      stage.align = "TL";
      graphics.beginFill(0xffffff);
      graphics.drawRect(24, 8, 4, 4);
      graphics.endFill();
      stage.addEventListener(MouseEvent.MOUSE_DOWN, function(event:MouseEvent):void {
        trace("site-fullscreen pointer", Math.floor(event.stageX), Math.floor(event.stageY));
      });
      stage.stage3Ds[0].addEventListener(Event.CONTEXT3D_CREATE, function(event:Event):void {
        var context:* = stage.stage3Ds[0].context3D;
        context.configureBackBuffer(32, 32, 0, false);
        context.clear(0, 1, 0, 1);
        context.present();
        trace("site-fullscreen ready");
      });
      stage.stage3Ds[0].requestContext3D();
    }
  }
}
