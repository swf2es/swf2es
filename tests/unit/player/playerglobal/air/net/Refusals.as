package {
  import air.net.WebSocket;
  import flash.display.Sprite;
  import flash.events.Event;
  public class Refusals extends Sprite {
    private var left:int = 2;
    public function Refusals() {
      for each (var url:String in ["ws://blocked.test:81/a", "ws://refused.test/b"]) {
        var w:WebSocket = new WebSocket();
        w.addEventListener("ioError", heard);
        w.addEventListener("securityError", heard);
        w.addEventListener("close", heard);
        w.connect(url);
      }
    }
    private function heard(e:Event):void {
      trace(e);
      if (--left == 0) {
        trace("done");
      }
    }
  }
}
