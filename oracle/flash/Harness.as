// The Flash oracle's harness: an AIR application that runs test SWFs as
// Flash Player does and sends back what they drew. oracle/flash.ts starts it
// with adl, passing a loopback port, and sends it jobs over a socket, little
// endian:
//
//   job:   u32 id, u32 background 0xRRGGBB, u16 width, u16 height,
//          f32 frame rate, u8 quality (0 low, 1 medium, 2 high, 3 best),
//          u16 frames to run, u16 n, u16[n] frames to capture,
//          u32 length, the SWF's bytes; id 0xFFFFFFFF ends the run.
//   reply: u8 1, u32 id, u16 frame, u32 length, PNG   a captured frame
//          u8 2, u32 id                              the job is done
//
// Each job's traces go to stdout between the lines "\x01swf2es:begin <id>"
// and "\x01swf2es:end <id>", and an error nothing caught as
// "\x01swf2es:error <text>", so that oracle/flash.ts can tell them apart.
// After a job ends, its content is unloaded, "\x01swf2es:settle <id>" is
// traced, and the next job starts SETTLE frames later: a listener of the
// last frame's EXIT_FRAME that runs after the harness's traces after the
// end, in no job's output, and what the content goes on doing after it is
// unloaded, an orphan movie of its own playing on, traces after the settle
// mark, which tells oracle/flash.ts to run the jobs after it again.
//
// Frame 1 is the frame the SWF's INIT follows: its first frame, constructed
// and with its scripts run. Frame k is captured at the (k-1)th EXIT_FRAME
// after that, when frame k's scripts have run. A frame's load completions
// (INIT, COMPLETE) follow its EXIT_FRAME, so what their listeners change
// shows in the next frame's capture, not this one's; a timer set here, or
// RENDER, would capture later, but Flash services a timer after the next
// frame's advance at times, and dispatches no RENDER in a frame whose
// script did a goto. An AVM1 movie in a Loader shows its frame 2 an
// EXIT_FRAME later than an AS3 one does, so for AVM1 the first EXIT_FRAME
// is skipped.
package {
  import flash.desktop.NativeApplication;
  import flash.display.BitmapData;
  import flash.display.Loader;
  import flash.display.PNGEncoderOptions;
  import flash.display.Sprite;
  import flash.display.StageAlign;
  import flash.display.StageQuality;
  import flash.display.StageScaleMode;
  import flash.events.ErrorEvent;
  import flash.events.Event;
  import flash.events.InvokeEvent;
  import flash.events.ProgressEvent;
  import flash.events.UncaughtErrorEvent;
  import flash.geom.Rectangle;
  import flash.net.Socket;
  import flash.system.LoaderContext;
  import flash.utils.ByteArray;
  import flash.utils.Endian;

  public class Harness extends Sprite {
    private var socket:Socket = new Socket();
    private var input:ByteArray = new ByteArray();
    private var loader:Loader;
    /** A job is running, or the last one's content is settling. */
    private var busy:Boolean = false;
    private var settling:int;
    private static const SETTLE:int = 3;
    private var id:uint;
    private var background:uint;
    private var width_:int;
    private var height_:int;
    private var frames:int;
    private var captures:Array;
    private var frame:int;
    private var lag:int;
    private var quality:String;
    private static const QUALITIES:Array = [
      StageQuality.LOW, StageQuality.MEDIUM, StageQuality.HIGH, StageQuality.BEST];

    public function Harness() {
      stage.scaleMode = StageScaleMode.NO_SCALE;
      stage.align = StageAlign.TOP_LEFT;
      stage.quality = StageQuality.HIGH;
      NativeApplication.nativeApplication.addEventListener(InvokeEvent.INVOKE, invoked);
    }

    private function invoked(e:InvokeEvent):void {
      socket.endian = Endian.LITTLE_ENDIAN;
      input.endian = Endian.LITTLE_ENDIAN;
      socket.addEventListener(ProgressEvent.SOCKET_DATA, received);
      socket.addEventListener(Event.CLOSE, function(_:Event):void { quit(); });
      socket.connect("127.0.0.1", int(e.arguments[0]));
    }

    private function quit():void {
      NativeApplication.nativeApplication.exit(0);
    }

    /** Buffer what arrives; start a job once one has arrived whole. */
    private function received(_:ProgressEvent):void {
      socket.readBytes(input, input.length);
      if (!busy) {
        next();
      }
    }

    private function next():void {
      input.position = 0;
      if (input.bytesAvailable < 4) {
        return;
      }

      id = input.readUnsignedInt();
      if (id == 0xffffffff) {
        quit();
        return;
      }

      if (input.bytesAvailable < 17) {
        return;
      }

      background = input.readUnsignedInt();
      width_ = input.readUnsignedShort();
      height_ = input.readUnsignedShort();
      var frameRate:Number = input.readFloat();
      quality = QUALITIES[input.readUnsignedByte()] || StageQuality.HIGH;
      frames = input.readUnsignedShort();
      var n:int = input.readUnsignedShort();
      if (input.bytesAvailable < n * 2 + 4) {
        return;
      }

      captures = [];
      for (var i:int = 0; i < n; i++) {
        captures.push(input.readUnsignedShort());
      }

      var length:uint = input.readUnsignedInt();
      if (input.bytesAvailable < length) {
        return;
      }

      var swf:ByteArray = new ByteArray();
      input.readBytes(swf, 0, length);
      var rest:ByteArray = new ByteArray();
      rest.endian = Endian.LITTLE_ENDIAN;
      input.readBytes(rest);
      input = rest;
      run(swf, frameRate);
    }

    private function run(swf:ByteArray, frameRate:Number):void {
      // The stage the SWF sees is its own size, at its own frame rate.
      stage.nativeWindow.width += width_ - stage.stageWidth;
      stage.nativeWindow.height += height_ - stage.stageHeight;
      stage.frameRate = frameRate;
      stage.quality = quality;
      frame = 0;
      busy = true;
      trace("\x01swf2es:begin " + id);
      loader = new Loader();
      loader.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR, uncaught);
      loader.contentLoaderInfo.addEventListener(Event.INIT, function(_:Event):void {
        frame = 1;
        lag = loader.contentLoaderInfo.actionScriptVersion == 2 ? 1 : 0;
        // Listening first: a job of no frames ends here, and done stops it.
        addEventListener(Event.EXIT_FRAME, exitFrame);
        captureIf();
      });
      addChild(loader);
      var context:LoaderContext = new LoaderContext();
      context.allowCodeImport = true;
      loader.loadBytes(swf, context);
    }

    private function uncaught(e:UncaughtErrorEvent):void {
      e.preventDefault();
      var error:* = e.error;
      var text:String = error is Error ? Error(error).toString()
        : error is ErrorEvent ? ErrorEvent(error).text : String(error);
      trace("\x01swf2es:error " + text);
    }

    private function exitFrame(_:Event):void {
      if (lag > 0) {
        lag--;
        return;
      }

      frame++;
      captureIf();
    }

    private function captureIf():void {
      if (captures.indexOf(frame) >= 0) {
        var image:BitmapData = new BitmapData(width_, height_, false, background);
        try {
          image.drawWithQuality(stage, null, null, null, null, false, quality);
        } catch (e:Error) {
          trace("\x01swf2es:error harness: " + e);
        }
        var png:ByteArray = image.encode(
          new Rectangle(0, 0, width_, height_), new PNGEncoderOptions());
        image.dispose();
        socket.writeByte(1);
        socket.writeUnsignedInt(id);
        socket.writeShort(frame);
        socket.writeUnsignedInt(png.length);
        socket.writeBytes(png);
        socket.flush();
      }

      if (frame >= frames) {
        done();
      }
    }

    private function done():void {
      if (!loader) {
        return;
      }

      removeEventListener(Event.EXIT_FRAME, exitFrame);
      // The run ends before the content goes: what its listeners trace as
      // it is unloaded is the harness's doing, not the SWF's.
      trace("\x01swf2es:end " + id);
      loader.unloadAndStop();
      removeChild(loader);
      loader = null;
      trace("\x01swf2es:settle " + id);
      socket.writeByte(2);
      socket.writeUnsignedInt(id);
      socket.flush();
      settling = SETTLE;
      addEventListener(Event.ENTER_FRAME, settle);
    }

    private function settle(_:Event):void {
      if (--settling > 0) {
        return;
      }

      removeEventListener(Event.ENTER_FRAME, settle);
      busy = false;
      next();
    }
  }
}
