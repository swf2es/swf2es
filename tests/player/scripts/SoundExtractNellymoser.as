package {
  import flash.display.Sprite;
  import flash.media.Sound;
  import flash.utils.ByteArray;
  import flash.utils.Endian;
  import flash.utils.getDefinitionByName;

  // Sound.extract of Nellymoser (cases.ts' extractNellymoser): at the rate
  // its flags give, formats 4 and 5 too, and a part within the sound as
  // long as asked. Not traced, since adl's Nellymoser extract is erratic
  // there: what a call asks for past 4096 samples or near the sound's end
  // (4095 gives 4094, 100000 gives 4096), and reading on past the end,
  // which can take adl down. Samples are not traced either, as Flash's
  // decoder fills its noise bands its own way and the samples between a
  // slower sound's own its own way too; the tones' period shows the rate.
  // tests/unit/native-audio.test.ts checks the samples against FFmpeg's.
  public class SoundExtractNellymoser extends Sprite {
    public function SoundExtractNellymoser() {
      var periods:Object = { Nelly22: 200, Nelly11: 400, Nelly16: 100, Nelly8: 800 };
      for each (var name:String in ["Nelly22", "Nelly11", "Nelly16", "Nelly8"]) {
        var s:Sound = new (getDefinitionByName(name) as Class)() as Sound;
        var parts:Array = [];
        for each (var start:Number in [0, 100, 2048, 4000]) {
          var b:ByteArray = new ByteArray();
          parts.push(start + ":" + s.extract(b, 1000, start) + ":" + b.length);
        }

        // The tones' period: 1/220 s as encoded at 22.05 kHz, so 200
        // samples at 44.1 kHz for a sound played at that rate, twice as many
        // at half the rate, and so on, whatever the noise; the lag within
        // four tenths of it the samples best match themselves at, in tens.
        b = new ByteArray();
        b.endian = Endian.LITTLE_ENDIAN;
        s.extract(b, 3000, 2000);
        var expected:int = periods[name];
        var x:Vector.<Number> = new Vector.<Number>(3000);
        for (var i:int = 0; i < 3000; i++) {
          b.position = i * 8;
          x[i] = b.readFloat();
        }

        var period:int = 0;
        var best:Number = -Infinity;
        for (var lag:int = expected * 0.6; lag <= expected * 1.4; lag++) {
          var sum:Number = 0;
          for (i = 0; i + lag < 3000; i++) {
            sum += x[i] * x[i + lag];
          }

          if (sum / (3000 - lag) > best) {
            best = sum / (3000 - lag);
            period = lag;
          }
        }

        trace(name, s.length, s.bytesTotal, parts.join(" "), "period", Math.round(period / 10) * 10);
      }
    }
  }
}
