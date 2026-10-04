package {
  import flash.display.SimpleButton;
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.media.Sound;
  import flash.media.SoundChannel;
  import flash.media.SoundMixer;
  import flash.media.SoundTransform;
  import flash.utils.ByteArray;
  import flash.utils.getDefinitionByName;

  public class MixerState extends Sprite {
    private var frame:int = 0;
    private var stopped:SoundChannel;
    private var later:SoundChannel;
    private var stoppedAt:Number = -1;
    private var events:Array = [];

    public function MixerState() {
      show("default", SoundMixer.soundTransform);
      var first:SoundTransform = SoundMixer.soundTransform;
      var second:SoundTransform = SoundMixer.soundTransform;
      trace("copy", first == second, first is SoundTransform);
      first.volume = 0.3;
      trace("copy volume", SoundMixer.soundTransform.volume);

      var assigned:SoundTransform = new SoundTransform(0.333, -0.5);
      SoundMixer.soundTransform = assigned;
      show("assigned", SoundMixer.soundTransform);
      trace("assigned same", assigned == SoundMixer.soundTransform);
      assigned.volume = 0.1;
      trace("assigned later", SoundMixer.soundTransform.volume);

      var odd:SoundTransform = new SoundTransform(2.5);
      odd.leftToRight = -0.125;
      odd.rightToLeft = 1 / 3;
      odd.rightToRight = 1.239;
      SoundMixer.soundTransform = odd;
      show("odd", SoundMixer.soundTransform);
      try {
        SoundMixer.soundTransform = null;
      } catch (e:Error) {
        trace("null transform", e.errorID, e.message);
      }
      show("after null", SoundMixer.soundTransform);
      var button:SimpleButton = new SimpleButton();
      show("button", button.soundTransform);
      button.soundTransform = new SoundTransform(0.7, 1);
      show("button global", SoundMixer.soundTransform);
      trace("button copy", button.soundTransform == button.soundTransform);
      SoundMixer.soundTransform = new SoundTransform(0.5, 0.25);

      trace("bufferTime", SoundMixer.bufferTime);
      SoundMixer.bufferTime = 120;
      trace("bufferTime", SoundMixer.bufferTime);
      SoundMixer.bufferTime = 2.7;
      trace("bufferTime", SoundMixer.bufferTime);
      try {
        SoundMixer.bufferTime = -3;
      } catch (e:Error) {
        trace("negative bufferTime", e.errorID, e.message);
      }
      trace("bufferTime", SoundMixer.bufferTime);
      SoundMixer.bufferTime = 5;
      trace("inaccessible", SoundMixer.areSoundsInaccessible());

      spectrum("empty", new ByteArray(), false, 0);
      var long:ByteArray = new ByteArray();
      for (var i:int = 0; i < 3000; i++) {
        long.writeByte(7);
      }
      long.position = 100;
      spectrum("long", long, false, 0);
      spectrum("fft", new ByteArray(), true, 0);
      spectrum("stretch", new ByteArray(), false, 4);
      try {
        SoundMixer.computeSpectrum(null);
      } catch (e:Error) {
        trace("null spectrum", e.errorID, e.message);
      }

      var Tone:Class = getDefinitionByName("Tone") as Class;
      var tone:Sound = new Tone() as Sound;
      stopped = tone.play();
      trace("local", stopped.soundTransform.volume, stopped.soundTransform.pan);
      stopped.addEventListener(Event.SOUND_COMPLETE, function(event:Event):void {
        events.push("stopped complete");
      });
      addEventListener(Event.ENTER_FRAME, onFrame);
    }

    private function onFrame(event:Event):void {
      frame++;
      if (frame == 3) {
        trace("stopAll", SoundMixer.stopAll());
        stoppedAt = stopped.position;
        show("after stopAll", SoundMixer.soundTransform);
        var Tone:Class = getDefinitionByName("Tone") as Class;
        later = (new Tone() as Sound).play();
        later.addEventListener(Event.SOUND_COMPLETE, function(event:Event):void {
          events.push("later complete");
        });
      }

      if (frame == 10) {
        trace("frozen", stopped.position == stoppedAt);
      }

      if (frame == 45) {
        trace("events", events.join(","));
        trace("frozen", stopped.position == stoppedAt);
        trace("later ended", later.position > 0);
      }
    }

    private function show(label:String, t:SoundTransform):void {
      trace(label, t.volume, t.pan, t.leftToLeft, t.leftToRight, t.rightToLeft, t.rightToRight);
    }

    private function spectrum(label:String, bytes:ByteArray, fft:Boolean, stretch:int):void {
      SoundMixer.computeSpectrum(bytes, fft, stretch);
      var sum:Number = 0;
      var position:uint = bytes.position;
      while (bytes.bytesAvailable >= 4) {
        sum += Math.abs(bytes.readFloat());
      }
      trace(label, bytes.length, position, sum);
    }
  }
}
