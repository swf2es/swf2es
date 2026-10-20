package {
  import flash.display.Bitmap;
  import flash.display.Loader;
  import flash.display.LoaderInfo;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.utils.ByteArray;

  public class Main extends Sprite {
    private var loader:Loader = new Loader();
    private var info:LoaderInfo;
    private var bitmap:Bitmap;
    private var frames:int = 0;

    public function Main() {
      addChild(loader);
      info = loader.contentLoaderInfo;
      for each (var type:String in ["open", "progress", "init", "complete", "ioError", "unload"]) {
        info.addEventListener(type, event);
      }

      // An original 2x1 RGBA PNG: opaque red, half-alpha green.
      var hex:String = "89504e470d0a1a0a0000000d4948445200000002000000010806000000f4227f8a0000001149444154789c63f8cfc0f09fe13f4303001079037e21c0fd8d0000000049454e44ae426082";
      var bytes:ByteArray = new ByteArray();
      for (var i:int = 0; i < hex.length; i += 2) {
        bytes.writeByte(parseInt(hex.substr(i, 2), 16));
      }

      facts("before");
      loader.loadBytes(bytes);
      facts("after");
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function facts(label:String):void {
      var names:Array = ["contentType", "width", "height", "swfVersion", "actionScriptVersion", "frameRate", "applicationDomain", "bytesLoaded", "bytesTotal"];
      for each (var name:String in names) {
        try {
          trace(label, name, info[name]);
        } catch (error:Error) {
          trace(label, name, error.name, error.errorID);
        }
      }
    }

    private function event(e:Event):void {
      trace("event", e.type, loader.content, loader.numChildren);
      facts(e.type);
      if (e.type == Event.COMPLETE) {
        bitmap = loader.content as Bitmap;
        trace("bitmap", bitmap.bitmapData.width, bitmap.bitmapData.height,
          bitmap.bitmapData.transparent, bitmap.pixelSnapping, bitmap.smoothing,
          bitmap.bitmapData.getPixel32(0, 0).toString(16),
          bitmap.bitmapData.getPixel32(1, 0).toString(16),
          bitmap.loaderInfo == info, bitmap.parent == loader, bitmap.root == bitmap);
        bitmap.scaleX = bitmap.scaleY = 24;
        loader.x = loader.y = 8;
      }
    }

    private function frame(e:Event):void {
      if (++frames == 3 && bitmap) {
        loader.unload();
        facts("after-unload");
        trace("retained", bitmap.parent, bitmap.loaderInfo == info,
          bitmap.bitmapData.getPixel32(0, 0).toString(16));
      }
    }
  }
}
