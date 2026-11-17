package {
  import flash.display.Sprite;
  import flash.events.ActivityEvent;
  import flash.events.Event;
  import flash.events.SampleDataEvent;
  import flash.external.ExternalInterface;
  import flash.media.Microphone;
  import flash.utils.getTimer;

  public class CaptureAudio extends Sprite {
    private var mic:Microphone = Microphone.getMicrophone();
    private var first:int = -1;
    private var last:int = 0;
    private var total:int = 0;
    private var next:Number = 0;
    private var continuous:Boolean = true;
    private var endian:Boolean = true;
    private var busy:Boolean = false;
    private var blocked:Boolean = false;
    private var activeAt:int = 0;
    private var activityCount:int = 0;
    private var activityTimeout:int = 0;

    public function CaptureAudio() {
      ExternalInterface.addCallback("audioBegin", begin);
      ExternalInterface.addCallback("audioActivity", activity);
      ExternalInterface.addCallback("audioActivityEnd", activityEnd);
      ExternalInterface.addCallback("audioLoopback", function(enabled:Boolean):void { mic.setLoopBack(enabled); });
      trace("audio: ready", mic.activityLevel);
    }

    public function begin(rate:int, pause:Boolean, slow:Boolean):void {
      stage.frameRate = slow ? 1 : 24;
      mic.rate = rate;
      mic.gain = 50;
      first = -1; last = total = 0; next = 0;
      continuous = endian = true; busy = pause; blocked = false;
      mic.addEventListener(SampleDataEvent.SAMPLE_DATA, samples);
      addEventListener(Event.ENTER_FRAME, frame);
    }

    private function samples(event:SampleDataEvent):void {
      var count:int = 0;
      while (event.data.bytesAvailable) { event.data.readFloat(); count++; }
      continuous = continuous && event.position == next;
      endian = endian && event.data.endian == "bigEndian";
      next = event.position + count;
      last = getTimer();
      if (first < 0) { first = last; } else { total += count; }
    }

    private function frame(event:Event):void {
      if (first < 0) { return; }
      mic.gain = 50;
      if (busy && !blocked && getTimer() - first > 400) {
        blocked = true;
        ExternalInterface.call("captureBusy");
      }
      if (getTimer() - first < 2000) { return; }
      mic.removeEventListener(SampleDataEvent.SAMPLE_DATA, samples);
      removeEventListener(Event.ENTER_FRAME, frame);
      trace("audio: count", mic.rate, total, last - first, continuous, endian, blocked);
    }

    public function activity(timeout:int):void {
      stage.frameRate = 24;
      activityTimeout = timeout;
      activityCount = 0;
      mic.gain = 50;
      mic.setSilenceLevel(timeout == 100 ? 100 : 10, timeout);
      mic.addEventListener(ActivityEvent.ACTIVITY, active);
      mic.addEventListener(SampleDataEvent.SAMPLE_DATA, discard);
    }

    private function discard(event:SampleDataEvent):void {}

    private function active(event:ActivityEvent):void {
      activityCount++;
      trace("audio: activity", event.activating, event is ActivityEvent, event.target == mic);
      if (event.activating) {
        activeAt = getTimer();
        mic.gain = 0;
      } else {
        trace("audio: silence", activityTimeout, getTimer() - activeAt, activityCount);
        activityEnd();
      }
    }

    public function activityEnd():void {
      mic.removeEventListener(ActivityEvent.ACTIVITY, active);
      mic.removeEventListener(SampleDataEvent.SAMPLE_DATA, discard);
      trace("audio: activity end", activityCount);
    }
  }
}
