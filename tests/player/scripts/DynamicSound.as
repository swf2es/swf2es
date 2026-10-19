package {
  import flash.display.Sprite;
  import flash.events.SampleDataEvent;
  import flash.media.Sound;
  import flash.media.SoundChannel;

  public class DynamicSound extends Sprite {
    public function DynamicSound() {
      probe(0);
      probe(1);
      probe(2047);
      probe(2048);
      probe(8192);
    }

    private function probe(count:int):void {
      var sound:Sound = new Sound();
      var calls:int = 0;
      sound.addEventListener(SampleDataEvent.SAMPLE_DATA, function(event:SampleDataEvent):void {
        trace(count, "samples", event.position, event.data.length, event.data.position, event.data.endian);
        if (calls++ == 0) {
          for (var i:int = 0; i < count; i++) {
            event.data.writeFloat(0.25);
            event.data.writeFloat(-0.5);
          }
        }
      });
      var channel:SoundChannel = sound.play();
      trace(count, "channel", channel != null, "length", sound.length);
      channel.stop();
    }
  }
}
