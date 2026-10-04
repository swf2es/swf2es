package {
  import flash.display.Sprite;
  import flash.media.SoundTransform;

  // A sprite's sound transform: a copy each read, kept in whole percents,
  // and a null refused.
  public class SpriteSound extends Sprite {
    public function SpriteSound() {
      var s:Sprite = new Sprite();
      var t:SoundTransform = s.soundTransform;
      trace("default", t.volume, t.pan, t.leftToLeft, t.rightToRight);
      t.volume = 0.5;
      trace("copy", s.soundTransform.volume, s.soundTransform == s.soundTransform);
      s.soundTransform = new SoundTransform(1 - 1 / 24, -0.333);
      t = s.soundTransform;
      trace("set", t.volume, t.pan, t.leftToLeft, t.rightToRight);
      try {
        s.soundTransform = null;
      } catch (e:Error) {
        trace("null", e);
      }

      trace("kept", s.soundTransform.volume);
      trace("root", soundTransform.volume);
    }
  }
}
