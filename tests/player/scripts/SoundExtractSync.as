package {
  import flash.display.Sprite;
  import flash.events.SampleDataEvent;
  import flash.media.Sound;
  import flash.utils.ByteArray;
  import flash.utils.getDefinitionByName;

  public class SoundExtractSync extends Sprite {
    public function SoundExtractSync() {
      for each (var name:String in ["Mp3", "Mp3Whole", "Mp3Mono22"]) {
        var sound:Sound = make(name) as Sound;
        var bytes:ByteArray = new ByteArray();
        var count:Number = sound.extract(bytes, 100000);
        bytes.position = 0;
        var energy:Number = 0;
        while (bytes.bytesAvailable >= 4) {
          energy += Math.abs(bytes.readFloat());
        }
        trace("first", name, count, bytes.length, energy > 1);
      }

      sound = make("Mp3Whole") as Sound;
      bytes = new ByteArray();
      trace("cursor", sound.extract(bytes, 2), sound.extract(bytes, 3), bytes.position);
      var other:ByteArray = new ByteArray();
      trace("instance", (make("Mp3Whole") as Sound).extract(other, 5), equal(bytes, other));
      trace("seek", sound.extract(bytes, 2, 12670), sound.extract(bytes, 2), bytes.position);

      var compressed:ByteArray = make("Mp3Bytes") as ByteArray;
      sound = new Sound();
      sound.loadCompressedDataFromByteArray(compressed, 1000);
      trace("partial", sound.extract(new ByteArray(), 100000));
      sound.loadCompressedDataFromByteArray(compressed, compressed.bytesAvailable);
      trace("appended", sound.extract(new ByteArray(), 100000, 0));

      var tagged:Sound = new Sound();
      compressed = make("Mp3Tagged") as ByteArray;
      tagged.loadCompressedDataFromByteArray(compressed, compressed.length);
      trace("header", tagged.extract(new ByteArray(), 100000));

      // A first extract in the same call stack as play must supply samples to the callback.
      sound = make("Mp3Whole") as Sound;
      var dynamic:Sound = new Sound();
      var requests:int = 0;
      dynamic.addEventListener(SampleDataEvent.SAMPLE_DATA, function(event:SampleDataEvent):void {
        var pcm:ByteArray = new ByteArray();
        var n:Number = sound.extract(pcm, 2048);
        pcm.position = 0;
        var first:Number = pcm.readFloat();
        trace("callback", requests++, n, pcm.length, first === first);
        event.data.writeBytes(pcm);
      });
      var channel:* = dynamic.play();
      trace("played", requests, channel !== null);
      if (channel) {
        channel.stop();
      }
    }

    private static function make(name:String):Object {
      var type:Class = getDefinitionByName(name) as Class;
      return new type();
    }

    private static function equal(a:ByteArray, b:ByteArray):Boolean {
      if (a.length !== b.length) {
        return false;
      }
      for (var i:int = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          return false;
        }
      }
      return true;
    }
  }
}
