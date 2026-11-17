package {
  import flash.display.BitmapData;
  import flash.display.MovieClip;
  import flash.display.Sprite;
  import flash.events.ActivityEvent;
  import flash.events.Event;
  import flash.filters.BlurFilter;
  import flash.events.SampleDataEvent;
  import flash.events.StatusEvent;
  import flash.external.ExternalInterface;
  import flash.geom.Rectangle;
  import flash.media.Camera;
  import flash.media.Microphone;
  import flash.media.Video;
  import flash.utils.ByteArray;

  public class CaptureDevices extends MovieClip {
    private var camera:Camera = Camera.getCamera();
    private var microphone:Microphone = Microphone.getMicrophone();
    private var video:Video = new Video(320, 240);
    private var frames:int = 0;
    private var samples:Boolean = false;

    public function CaptureDevices() {
      stop();
      camera.setMode(320, 240, 15);
      camera.setMotionLevel(1);
      microphone.rate = 22;
      microphone.gain = 50;
      microphone.setSilenceLevel(10);
      camera.addEventListener(StatusEvent.STATUS, status);
      microphone.addEventListener(StatusEvent.STATUS, status);
      camera.addEventListener("permissionStatus", permission);
      microphone.addEventListener("permissionStatus", permission);
      addChild(video);
      addEventListener(Event.ENTER_FRAME, idle);
      ExternalInterface.addCallback("captureCommand", command);
      trace("capture: initial", Camera.names.length > 0, Microphone.names.length > 0,
        camera.muted, microphone.muted, camera.motionTimeout, microphone.silenceTimeout);
    }

    private function idle(event:Event):void {
      if (++frames == 30) {
        removeEventListener(Event.ENTER_FRAME, idle);
        trace("capture: idle", camera.muted, microphone.muted);
      }
    }

    private function status(event:StatusEvent):void {
      trace("capture: status", event.code, event.level, event is StatusEvent,
        event.target == camera || event.target == microphone,
        event.target.muted);
    }

    private function permission(event:Event):void {
      trace("capture: permission", event.target == camera ? "camera" : "microphone",
        Object(event).status, event.target == camera || event.target == microphone);
    }

    private function sample(event:SampleDataEvent):void {
      if (!samples) {
        samples = true;
        trace("capture: samples", event is SampleDataEvent, event.target == microphone,
          event.data.length > 0, event.data.endian);
      }
    }

    private function picture(event:Event):void {
      if (video.videoWidth == 0) {
        return;
      }

      camera.removeEventListener("videoFrame", picture);
      var bitmap:BitmapData = new BitmapData(320, 240, true, 0);
      bitmap.draw(video);
      var bytes:ByteArray = new ByteArray();
      var rect:Rectangle = new Rectangle(0, 0, 320, 240);
      camera.copyToByteArray(rect, bytes);
      bytes.position = 0;
      var pixels:Vector.<uint> = new Vector.<uint>(320 * 240);
      camera.copyToVector(rect, pixels);
      trace("capture: picture", video.videoWidth, video.videoHeight,
        bitmap.getPixel32(160, 120) != 0, bytes.length, bytes.readUnsignedByte(), pixels.length);
      var small:BitmapData = new BitmapData(1, 1);
      try { camera.drawToBitmapData(small); } catch (error:Error) {
        trace("capture: small", error.errorID);
      }
      try { camera.copyToByteArray(null, bytes); } catch (error:Error) {
        trace("capture: null", error.errorID);
      }
      try { camera.copyToVector(rect, null); } catch (error:Error) {
        trace("capture: null vector", error.errorID);
      }
      bitmap.dispose();
      small.dispose();
    }

    private var retained:BitmapData;

    public function command(action:String):void {
      switch (action) {
        case "filter":
          video.filters = [new BlurFilter(4, 4, 1)];
          break;
        case "cached":
          var cache:Sprite = new Sprite();
          addChild(cache);
          cache.addChild(video);
          cache.cacheAsBitmap = true;
          break;
        case "motion":
          camera.setMotionLevel(1, 500);
          camera.addEventListener(ActivityEvent.ACTIVITY, function(event:ActivityEvent):void {
            trace("capture: motion", event.activating, event is ActivityEvent, event.target == camera);
          });
          break;
        case "motion default":
          camera.setMotionLevel(50);
          var observed:int = 0;
          var maximum:Number = 0;
          var measure:Function = function(event:Event):void {
            maximum = Math.max(maximum, camera.activityLevel);
            if (++observed == 15) {
              camera.removeEventListener("videoFrame", measure);
              trace("capture: default motion", maximum);
            }
          };
          camera.addEventListener("videoFrame", measure);
          break;
        case "camera":
          camera.addEventListener("videoFrame", picture);
          video.attachCamera(camera);
          break;
        case "detach":
          video.attachCamera(null);
          retained = new BitmapData(320, 240, true, 0);
          retained.draw(video);
          trace("capture: retained", retained.getPixel32(100, 100) != 0, video.videoWidth, video.videoHeight);
          break;
        case "retained":
          var after:BitmapData = new BitmapData(320, 240, true, 0);
          after.draw(video);
          trace("capture: still", retained.compare(after) == 0);
          retained.dispose(); retained = null; after.dispose();
          break;
        case "microphone":
          samples = false;
          microphone.addEventListener(SampleDataEvent.SAMPLE_DATA, sample);
          break;
        case "unsample":
          microphone.removeEventListener(SampleDataEvent.SAMPLE_DATA, sample);
          break;
        case "transfer":
          var previous:Video = video;
          video = new Video(320, 240);
          addChild(video);
          video.attachCamera(camera);
          trace("capture: transfer", previous.videoWidth);
          previous.parent.removeChild(previous);
          break;
        case "drop":
          camera.removeEventListener("videoFrame", picture);
          video.parent.removeChild(video);
          video = null;
          break;
        case "denied":
          var untouched:BitmapData = new BitmapData(1, 1, true, 0xFF123456);
          untouched.draw(video);
          trace("capture: denied", camera.muted, video.videoWidth,
            untouched.getPixel32(0, 0) == 0xFF123456);
          untouched.dispose();
          break;
        case "permission":
          Object(camera).requestPermission();
          Object(microphone).requestPermission();
          break;
      }
    }
  }
}
