package {
  import flash.display.Sprite;
  import flash.events.Event;
  import flash.media.Sound;
  import flash.utils.ByteArray;
  import flash.utils.Endian;
  import flash.utils.getDefinitionByName;

  // Sound.extract, loadPCMFromByteArray and loadCompressedDataFromByteArray
  // (cases.ts' extractSounds). An MP3's samples are traced a frame later, as
  // the player's decoder gives them late; they are checked against adl's to
  // a tolerance, as two decoders differ in their last bits. adl's
  // loadPCMFromByteArray reads back samples that have nothing to do with
  // those it was given, so only its counts and lengths are traced.
  public class SoundExtract extends Sprite {
    private var mp3s:Object = {};
    private var loaded:Sound;
    private var part:Sound;
    private var junk:Sound;
    private var tagged:Sound;
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

      loadPcm();
      loadCompressed();
      addEventListener(Event.ENTER_FRAME, frames);
    }

    private function loadPcm():void {
      var pcm:ByteArray = new ByteArray();
      for (var i:int = 0; i < 20; i++) {
        pcm.writeFloat(i / 20);
      }

      pcm.position = 0;
      var p:Sound = new Sound();
      p.addEventListener(Event.COMPLETE, function (e:Event):void { trace("pcm complete"); });
      p.loadPCMFromByteArray(pcm, 10);
      var b:ByteArray = new ByteArray();
      trace("pcm float", p.length, p.bytesLoaded, p.bytesTotal, pcm.position, p.extract(b, 100),
        b.length, p.extract(b, 3, 2), b.length);
      for each (var rate:Number in [22050, 11025, 5512.5, 48000, 12345, 0, -1]) {
        pcm.position = 0;
        p = new Sound();
        try {
          p.loadPCMFromByteArray(pcm, 4, "short", false, rate);
          b = new ByteArray();
          trace("rate", rate, p.length, p.bytesLoaded, pcm.position, p.extract(b, 100));
        } catch (e:Error) {
          trace("rate", rate, e.errorID, pcm.position);
        }
      }

      for each (var format:String in ["SHORT", "foo", null]) {
        pcm.position = 0;
        try {
          new Sound().loadPCMFromByteArray(pcm, 4, format, false);
          trace("format", format);
        } catch (e:Error) {
          trace("format", format, e.errorID);
        }
      }

      for each (var samples:int in [0, 11, 10]) {
        pcm.position = 0;
        try {
          p = new Sound();
          p.loadPCMFromByteArray(pcm, samples);
          trace("samples", samples, p.length, pcm.position);
        } catch (e:Error) {
          trace("samples", samples, e.errorID, pcm.position);
        }
      }

      try {
        new Sound().loadPCMFromByteArray(null, 1);
      } catch (e:Error) {
        trace("null bytes", e.errorID);
      }

      pcm.position = 0;
      p.loadPCMFromByteArray(pcm, 2, "short", false);
      trace("again", p.length, pcm.position);
      var s:Sound = make("Pcm8");
      pcm.position = 0;
      s.loadPCMFromByteArray(pcm, 2, "short", false);
      trace("over a SWF's", s.length, pcm.position, s.extract(new ByteArray(), 100, 0));
    }

    private function loadCompressed():void {
      var Bytes:Class = getDefinitionByName("Mp3Bytes") as Class;
      var mp3:ByteArray = new Bytes() as ByteArray;
      loaded = new Sound();
      for each (var type:String in ["open", "progress", "complete", "id3"]) {
        loaded.addEventListener(type, function (e:Event):void {
          trace("event", e.type, frame, e is Object && "bytesLoaded" in e ? e["bytesLoaded"] : "");
        });
      }

      loaded.loadCompressedDataFromByteArray(mp3, mp3.length);
      trace("compressed", loaded.length, loaded.bytesLoaded, loaded.bytesTotal, mp3.position);
      part = new Sound();
      mp3.position = 0;
      part.loadCompressedDataFromByteArray(mp3, 1000);
      trace("part", part.length, mp3.position);
      part.loadCompressedDataFromByteArray(mp3, 1000);
      trace("more", part.length, part.bytesTotal, mp3.position);
      mp3.position = 3000;
      try {
        new Sound().loadCompressedDataFromByteArray(mp3, 1000);
      } catch (e:Error) {
        trace("past the bytes", e.errorID, mp3.position);
      }

      try {
        new Sound().loadCompressedDataFromByteArray(new ByteArray(), 0);
      } catch (e:Error) {
        trace("no bytes", e.errorID);
      }

      try {
        new Sound().loadCompressedDataFromByteArray(null, 0);
      } catch (e:Error) {
        trace("null bytes", e.errorID);
      }

      var text:ByteArray = new ByteArray();
      text.writeUTFBytes("this is not an mp3 file at all, not one frame of it");
      text.position = 0;
      junk = new Sound();
      junk.loadCompressedDataFromByteArray(text, text.length);
      trace("junk", junk.length, junk.bytesTotal);
      var Tagged:Class = getDefinitionByName("Mp3Tagged") as Class;
      var withHeader:ByteArray = new Tagged() as ByteArray;
      tagged = new Sound();
      tagged.loadCompressedDataFromByteArray(withHeader, withHeader.length);
      trace("tagged", tagged.length);
      for each (var s:Sound in [loaded, part, tagged]) {
        s.extract(new ByteArray(), 1, 0);
      }
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
      check("compressed", loaded, [0, -2, -434, -542, -591, -577, -500, -369, -198, -6, 187, 359, 493],
        [0, 10, 279, 294, 237, 122, -20, -159, -259, -297, -263, -166, -29]);
      check("tagged", tagged, [0, 0, 3, 532, 594, 582, 512, 387, 220, 29, -165, -341, -480, -562],
        [0, 0, -14, -28, -164, -262, -297, -260, -160, -22, 121, 236, 293, 280]);
      var b:ByteArray = new ByteArray();
      trace("part", part.extract(b, 100000, 0), "junk", junk.extract(b, 100000, 0));

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
