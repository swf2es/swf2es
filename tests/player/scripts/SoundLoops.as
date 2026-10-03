package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.media.SoundChannel;

  public class SoundLoops extends Sprite {
    private var frame:int = 0;
    private var completed:Array = [false, false, false, false];

    public function SoundLoops() {
      addEventListener(Event.ENTER_FRAME, onFrame);
      start(0);
      start(1);
      start(2);
      start(3);
    }

    private function onFrame(event:Event):void {
      frame++;
      if (frame == 20 || frame == 30 || frame == 42) {
        trace("frame", frame, completed.join(","));
      }
    }

    private function start(loops:int):void {
      var channel:SoundChannel = new Tone().play(0, loops);
      channel.addEventListener(Event.SOUND_COMPLETE, function(event:Event):void {
        completed[loops] = true;
      });
    }
  }
}
