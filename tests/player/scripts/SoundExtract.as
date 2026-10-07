package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.media.Sound;
  import flash.utils.ByteArray;
  import flash.utils.Endian;
  import flash.utils.getDefinitionByName;

  // Sound.extract (cases.ts' extractSounds). An MP3's samples are traced a
  // frame later, as the player's decoder gives them late; they are checked
  // against adl's to a tolerance, as two decoders differ in their last bits.
  public class SoundExtract extends Sprite {
    private var mp3s:Object = {};
    private var frame:int = 0;

    public function SoundExtract() {
      for each (var name:String in ["Pcm8", "Pcm16Stereo", "Pcm11", "Pcm22"]) {
        var s:Sound = make(name);
        var b:ByteArray = new ByteArray();
        var n:Number = s.extract(b, 100000);
        trace(name, s.length, s.bytesTotal, n, b.length, b.position, floats(b, 0, 40));
      }

      s = make("Pcm16Stereo");
      b = new ByteArray();
      trace("go on", s.extract(b, 10), s.extract(b, 10), b.length, floats(b, 18, 4));
      b = new ByteArray();
      trace("start", s.extract(b, 10, 95), b.length, floats(b, 0, 4), s.extract(b, 3));
      trace("past", s.extract(b, 10, 200), s.extract(b, 10, 100), s.extract(b, 10, 99));
      trace("none", s.extract(b, 0), s.extract(b, -5), s.extract(b, NaN));
      trace("fractions", s.extract(b, 2.7, 0), s.extract(b, 2, 3.7), floats(b, b.length / 4 - 4, 4));
      b = new ByteArray();
      b.writeUTFBytes("abcdefghijkl");
      b.position = 4;
      trace("at position", s.extract(b, 1, 0), b.length, b.position, b[0], b[3], b[4], b[12]);
      b = new ByteArray();
      s.extract(b, 1, 60);
      trace("big endian", bytes(b));
      b = new ByteArray();
      b.endian = Endian.LITTLE_ENDIAN;
      s.extract(b, 1, 60);
      trace("little endian", bytes(b));
      trace("null", s.extract(null, 10));

      s = make("Pcm11");
      b = new ByteArray();
      trace("whole samples", s.extract(b, 10), b.length, s.extract(b, 3), b.length,
        s.extract(b, 4), b.length, s.extract(b, 5, 9), b.length, s.extract(b, 100, 49), b.length);
      s = make("Pcm8");
      b = new ByteArray();
      trace("own samples", s.extract(b, 20), b.length, s.extract(b, 300, 250), b.length,
        s.extract(b, 300, 31), b.length);

      for each (name in ["Mp3", "Mp3Whole", "Mp3Mono22"]) {
        s = make(name);
        trace(name, s.length, s.bytesTotal);
        s.extract(new ByteArray(), 1, 0);
        mp3s[name] = s;
      }

      addEventListener(Event.ENTER_FRAME, frames);
    }

    private function frames(e:Event):void {
      frame++;
      if (frame !== 1) {
        return;
      }

      check("Mp3", mp3s["Mp3"], [7, -194, -365, -497, -576, -592, -544, -437, -283, -99, 97, 282],
        [18, -141, -249, -296, -272, -183, -49, 96, 218, 287, 288, 219]);
      check("Mp3Whole", mp3s["Mp3Whole"],
        [0, -2, -434, -542, -591, -577, -500, -369, -198, -6, 187, 359, 493],
        [0, 10, 279, 294, 237, 122, -20, -159, -259, -297, -263, -166, -29]);
      check("Mp3Mono22", mp3s["Mp3Mono22"],
        [0, 0, -1, -425, -390, -281, -178, -14, 89, 202, 248, 266, 249, 198],
        [0, 0, -1, -425, -390, -281, -178, -14, 89, 202, 248, 266, 249, 198]);
      var s:Sound = mp3s["Mp3Mono22"];
      b = new ByteArray();
      trace("mp3 22", s.extract(b, 10, 1000), b.length, s.extract(b, 10), b.length,
        s.extract(b, 100, 6911), b.length, s.extract(b, 100, 13800), b.length);
      s = mp3s["Mp3"];
      b = new ByteArray();
      trace("mp3 to end", s.extract(b, 100, 11560), b.length);
    }

    /** Every 997th sample, left and right, against adl's to a tolerance. */
    private function check(name:String, s:Sound, left:Array, right:Array):void {
      var b:ByteArray = new ByteArray();
      b.endian = Endian.LITTLE_ENDIAN;
      var n:Number = s.extract(b, 100000, 0);
      var l:Array = [];
      var r:Array = [];
      for (var i:int = 0; i < n * 8 && i * 8 < b.length; i += 997) {
        b.position = i * 8;
        l.push(Math.round(b.readFloat() * 10000));
        r.push(Math.round(b.readFloat() * 10000));
      }

      var close:Boolean = l.length === left.length;
      for (i = 0; i < l.length; i++) {
        close &&= Math.abs(l[i] - left[i]) <= 5 && Math.abs(r[i] - right[i]) <= 5;
      }

      trace(name, n, b.length, close);
    }

    private function make(name:String):Sound {
      var C:Class = getDefinitionByName(name) as Class;
      return new C() as Sound;
    }

    private static function floats(b:ByteArray, from:int, count:int):String {
      var out:Array = [];
      var at:uint = b.position;
      b.position = from * 4;
      for (var i:int = 0; i < count && b.bytesAvailable >= 4; i++) {
        out.push(Math.round(b.readFloat() * 100000) / 100000);
      }

      b.position = at;
      return out.join(",");
    }

    private static function bytes(b:ByteArray):String {
      var out:Array = [];
      for (var i:int = 0; i < b.length; i++) {
        out.push(b[i]);
      }

      return out.join(" ");
    }
  }
}
