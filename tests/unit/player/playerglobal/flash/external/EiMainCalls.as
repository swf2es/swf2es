package {
  import flash.display.Loader;
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.external.ExternalInterface;
  import flash.net.URLLoader;
  import flash.net.URLLoaderDataFormat;
  import flash.net.URLRequest;
  import flash.system.fscommand;
  public class EiMainCalls extends MovieClip {
    private var ran:Boolean = false;

    public function EiMainCalls() {
      var loader:Loader = new Loader();
      loader.load(new URLRequest("http://other.test/child.swf"));
      addChild(loader);
      // Bytes it loads itself: the content is the main SWF's.
      var stream:URLLoader = new URLLoader();
      stream.dataFormat = URLLoaderDataFormat.BINARY;
      stream.addEventListener(Event.COMPLETE, function (e:Event):void {
        new Loader().loadBytes(stream.data);
      });
      stream.load(new URLRequest("http://page.test/own.swf"));
      addFrameScript(2, frameScript);
      addEventListener(Event.ENTER_FRAME, enterFrame);
    }

    private function frameScript():void {
      ExternalInterface.call("hello", "frame script");
      fscommand("frame script", "");
      stop();
    }

    private function enterFrame(e:Event):void {
      if (currentFrame == 3 && !ran) {
        ran = true;
        ExternalInterface.call("hello", "enterFrame");
        fscommand("enterFrame", "");
      }
    }
  }
}
