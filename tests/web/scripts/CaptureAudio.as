package {
  import flash.display.Sprite;
  import flash.events.ActivityEvent;
  import flash.events.Event;
  import flash.events.SampleDataEvent;
  import flash.events.StatusEvent;
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
    private var points:Array = [];
    private var order:Array = [];

    public function CaptureAudio() {
      ExternalInterface.addCallback("audioOrder", function():void {
        addEventListener(Event.ENTER_FRAME, orderStart);
      });
      ExternalInterface.addCallback("audioBegin", begin);
      ExternalInterface.addCallback("audioActivity", activity);
      ExternalInterface.addCallback("audioActivityEnd", activityEnd);
      ExternalInterface.addCallback("audioLoopback", function(enabled:Boolean):void { mic.setLoopBack(enabled); });
      trace("audio: ready", mic.activityLevel);
    }

    // Right after a frame, so the next one, which tells of the grant, is seconds away.
    private function orderStart(event:Event):void {
      removeEventListener(Event.ENTER_FRAME, orderStart);
      stage.frameRate = 0.4;
      mic.addEventListener(StatusEvent.STATUS, orderStatus);
      mic.addEventListener(SampleDataEvent.SAMPLE_DATA, orderSamples);
    }

    private function orderStatus(event:StatusEvent):void {
      order.push(event.code);
      orderDone();
    }

    private function orderSamples(event:SampleDataEvent):void {
      if (order.indexOf("samples") < 0) {
        order.push("samples");
      }
      orderDone();
    }

    private function orderDone():void {
      if (order.length < 2) { return; }
      mic.removeEventListener(StatusEvent.STATUS, orderStatus);
      mic.removeEventListener(SampleDataEvent.SAMPLE_DATA, orderSamples);
      stage.frameRate = 24;
      trace("audio: order", order.join(","));
    }

    public function begin(rate:int, pause:Boolean, slow:Boolean):void {
      stage.frameRate = slow ? 1 : 24;
      mic.rate = rate;
      mic.gain = 50;
      first = -1; last = total = 0; next = 0; points = [];
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
      points.push(last + ":" + next);
      if (first < 0) { first = last; } else { total += count; }
    }

    private function frame(event:Event):void {
      if (first < 0) { return; }
      mic.gain = 50;
      if (busy && !blocked && getTimer() - first > 400) {
        // Longer than a worklet block or two: one credit would lose about a tenth of the window.
        blocked = true;
        ExternalInterface.call("captureBusy");
      }
      if (getTimer() - first < 2000) { return; }
      mic.removeEventListener(SampleDataEvent.SAMPLE_DATA, samples);
      removeEventListener(Event.ENTER_FRAME, frame);
      trace("audio: count", mic.rate, total, last - first, continuous, endian, blocked, points.join(","));
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
