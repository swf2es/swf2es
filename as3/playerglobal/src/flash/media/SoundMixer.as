// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/media/SoundMixer.ts.

package flash.media
{
	import flash.utils.ByteArray;

	public final class SoundMixer
	{
		public function SoundMixer()
		{
		}

		public static native function stopAll():void;
		public static native function computeSpectrum(outputArray:ByteArray, FFTMode:Boolean = false, stretchFactor:int = 0):void;
		public static native function get bufferTime():int;
		public static native function set bufferTime(value:int):void;
		public static native function get soundTransform():SoundTransform;
		public static native function set soundTransform(value:SoundTransform):void;
		public static native function areSoundsInaccessible():Boolean;
		[API("675")]
		public static native function get audioPlaybackMode():String;
		[API("675")]
		public static native function set audioPlaybackMode(arg0:String):void;
		[API("675")]
		public static native function get useSpeakerphoneForVoice():Boolean;
		[API("675")]
		public static native function set useSpeakerphoneForVoice(arg0:Boolean):void;
	}
}
