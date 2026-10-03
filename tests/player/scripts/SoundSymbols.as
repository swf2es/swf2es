package {
  import flash.display.Sprite;
  import flash.media.Sound;
  import flash.media.SoundChannel;
  import flash.media.SoundTransform;
  import flash.utils.getDefinitionByName;

  public class SoundSymbols extends Sprite {
    public function SoundSymbols() {
      var Tone:Class = getDefinitionByName("Tone") as Class;
      var tone:Sound = new Tone() as Sound;
      trace("embedded", tone.bytesLoaded, tone.bytesTotal, tone.length,
        tone.isBuffering, tone.isURLInaccessible, tone.url);
      var channel:SoundChannel = tone.play();
      trace("channel", channel, channel.position);
      var transform:SoundTransform = channel.soundTransform;
      transform.volume = 0.25;
      trace("copy", channel.soundTransform.volume);
      channel.soundTransform = transform;
      trace("set", channel.soundTransform.volume);
      channel.stop();
      trace("past end", tone.play(1001));
    }
  }
}
