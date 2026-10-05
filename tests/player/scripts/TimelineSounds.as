package {
  import flash.display.MovieClip;
  import flash.events.Event;
  import flash.media.SoundChannel;
  import flash.media.SoundMixer;
  import flash.media.SoundTransform;

  // Timeline sounds leave the timeline as it was: the root starts Tone,
  // SyncNoMultiple, stops it, SyncStop, and starts it twice over; its
  // child "streamer" has a stream sound, a block a frame, which the script
  // stops, plays, sends to frames, gives a transform and stops with the
  // mixer; nothing of it skips a frame. A channel of Tone a script started
  // plays on through the timeline's SyncStop of it, to its complete.
  public dynamic class TimelineSounds extends MovieClip {
    private var n:int = 0;
    private var completed:Boolean = false;

    public function TimelineSounds() {
      var channel:SoundChannel = new Tone().play();
      channel.addEventListener(Event.SOUND_COMPLETE, function(event:Event):void {
        completed = true;
      });
      addEventListener(Event.ENTER_FRAME, onFrame);
    }

    private function onFrame(event:Event):void {
      n++;
      var streamer:MovieClip = getChildByName("streamer") as MovieClip;
      if (n == 3) {
        streamer.stop();
      } else if (n == 5) {
        streamer.play();
      } else if (n == 8) {
        streamer.gotoAndPlay(2);
      } else if (n == 10) {
        streamer.gotoAndStop(5);
      } else if (n == 12) {
        streamer.soundTransform = new SoundTransform(0.5);
        streamer.play();
      } else if (n == 29) {
        SoundMixer.stopAll();
      }

      if (n <= 29) {
        trace("frame", n, currentFrame, streamer.currentFrame);
      }

      if (n == 12 || n == 28) {
        trace("completed", n, completed);
      }
    }
  }
}
