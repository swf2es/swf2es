package {
  import flash.display.BitmapData;
  import flash.display.Sprite;
  import flash.display.Stage3D;
  import flash.events.ErrorEvent;
  import flash.events.Event;

  // Back buffers as large as a 2K or 4K screen, which a SWF that sizes its back buffer to the stage
  // asks for there, in every profile; the sizes refused, and maxBackBufferWidth and
  // maxBackBufferHeight. The context is untyped: SWFs before 26 have no backBufferWidth,
  // maxBackBufferWidth or profile, and read them as missing.
  public class BackBuffer extends Sprite {
    public var complete:Boolean = false;
    private var slot:Stage3D;
    private var c:Object;
    // AIR takes these sizes alike in all six profiles; swf2es serves baseline and
    // baselineConstrained. In baselineConstrained AIR draws no back buffer larger than the
    // stage (#3710 from SWF 30, #3723 before), which swf2es leaves unchecked: the
    // BackBufferConstrained variant, which run.ts checks without AIR.
    private var profiles:Array = ["baseline"];
    private var next:int = 0;
    private var pixels:BitmapData = new BitmapData(32, 32, true, 0);

    public function BackBuffer() {
      if (stage) {
        start();
      } else {
        addEventListener(Event.ADDED_TO_STAGE, start);
      }
    }

    private function start(event:Event = null):void {
      removeEventListener(Event.ADDED_TO_STAGE, start);
      slot = stage.stage3Ds[0];
      slot.addEventListener(Event.CONTEXT3D_CREATE, created);
      slot.addEventListener(ErrorEvent.ERROR, refused);
      request();
    }

    private function request():void {
      try {
        slot.requestContext3D("auto", profiles[next]);
      } catch (error:Error) {
        trace("backbuffer", profiles[next], "request", error.errorID);
        after();
      }
    }

    private function refused(event:ErrorEvent):void {
      trace("backbuffer", profiles[next], "refused", event.errorID);
      after();
    }

    private function read(name:String):String {
      try {
        return String(c[name]);
      } catch (error:Error) {
        return "missing";
      }

      return "";
    }

    private function sizes():String {
      return read("backBufferWidth") + "x" + read("backBufferHeight") + " most " +
        read("maxBackBufferWidth") + "x" + read("maxBackBufferHeight");
    }

    private function probe(label:String, action:Function):void {
      var result:String = "ok";
      try {
        action();
      } catch (error:Error) {
        result = error.name + " " + error.errorID;
      }
      trace("backbuffer", label, result, sizes());
    }

    private function frame(width:int, height:int, antiAlias:int):void {
      c.configureBackBuffer(width, height, antiAlias, true);
      c.clear(0.2, 0.4, 1, 1);
      c.drawToBitmapData(pixels);
      c.present();
      trace("backbuffer", profiles[next], width + "x" + height, "aa" + antiAlias,
        pixels.getPixel32(5, 5).toString(16), sizes());
    }

    private function created(event:Event):void {
      c = slot.context3D;
      c.enableErrorChecking = true;
      trace("backbuffer", profiles[next], "created", read("profile"), sizes());
      if (next == 0) {
        refusals();
      }

      probe(profiles[next] + " screens", function():void {
        frame(2560, 1440, 0);
        frame(3840, 2160, 0);
        frame(2560, 1440, 4);
        frame(3840, 2160, 2);
        frame(64, 64, 0);
      });
      c.dispose(false);
      after();
    }

    private function refusals():void {
      probe("present-unconfigured", function():void { c.present(); });
      probe("w31", function():void { c.configureBackBuffer(31, 64, 0, true); });
      probe("h31", function():void { c.configureBackBuffer(64, 31, 0, true); });
      probe("w0", function():void { c.configureBackBuffer(0, 64, 0, true); });
      probe("wneg", function():void { c.configureBackBuffer(-5, 64, 0, true); });
      probe("wnan", function():void { c.configureBackBuffer(NaN, 64, 0, true); });
      probe("16384", function():void { c.configureBackBuffer(16384, 32, 0, true); });
      probe("w16385", function():void { c.configureBackBuffer(16385, 64, 0, true); });
      probe("h16385", function():void { c.configureBackBuffer(64, 16385, 0, true); });
      probe("both", function():void { c.configureBackBuffer(16385, 16385, 0, true); });
      probe("configured", function():void { c.configureBackBuffer(64, 64, 0, true); });
      probe("refused-after", function():void { c.configureBackBuffer(64, 16385, 0, true); });
      probe("clear-after-refusal", function():void { c.clear(); });
      c.enableErrorChecking = false;
      probe("unchecked-clear-after-refusal", function():void { c.clear(); });
      probe("unchecked-present-after-refusal", function():void { c.present(); });
      c.enableErrorChecking = true;
      probe("present-after-refusal", function():void { c.present(); });
      probe("most-16", function():void { c.maxBackBufferWidth = 16; c.maxBackBufferHeight = 16; });
      probe("most-100x50", function():void { c.maxBackBufferWidth = 100; c.maxBackBufferHeight = 50; });
      probe("101x50", function():void { c.configureBackBuffer(101, 50, 0, true); });
      probe("100x51", function():void { c.configureBackBuffer(100, 51, 0, true); });
      probe("100x50", function():void { c.configureBackBuffer(100, 50, 0, true); });
      probe("most-40", function():void { c.maxBackBufferWidth = 40; c.maxBackBufferHeight = 40; });
      probe("most-20000", function():void { c.maxBackBufferWidth = 20000; c.maxBackBufferHeight = 300.7; });
      probe("most-back", function():void { c.maxBackBufferWidth = 16384; c.maxBackBufferHeight = 16384; });
    }

    private function after():void {
      next++;
      if (next < profiles.length) {
        request();
        return;
      }

      probe("disposed", function():void {});
      probe("disposed-most-64", function():void { c.maxBackBufferWidth = 64; });
      trace("backbuffer complete");
      complete = true;
    }
  }
}
