// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/media/Sound.ts.

package flash.media
{
	import flash.events.EventDispatcher;
	import flash.net.URLRequest;
	import flash.utils.ByteArray;

	public class Sound extends EventDispatcher
	{
		public function Sound(stream:URLRequest = null, context:SoundLoaderContext = null)
		{
		}

		public native function load(stream:URLRequest, context:SoundLoaderContext = null):void;
		[API("674")]
		public native function loadCompressedDataFromByteArray(bytes:ByteArray, bytesLength:uint):void;
		[API("674")]
		public native function loadPCMFromByteArray(bytes:ByteArray, samples:uint, format:String = "float", stereo:Boolean = true, sampleRate:Number = 44100):void;
		public native function get url():String;
		public native function get isURLInaccessible():Boolean;
		public native function play(startTime:Number = 0, loops:int = 0, sndTransform:SoundTransform = null):SoundChannel;
		public native function get length():Number;
		public native function get isBuffering():Boolean;
		public native function get bytesLoaded():uint;
		public native function get bytesTotal():int;
		public native function get id3():ID3Info;
		public native function close():void;
		[API("662")]
		public native function extract(target:ByteArray, length:Number, startPosition:Number = -1):Number;
	}
}
