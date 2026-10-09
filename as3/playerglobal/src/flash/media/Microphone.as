// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.media
{
	import flash.events.EventDispatcher;

	public final class Microphone extends EventDispatcher
	{
		public function Microphone()
		{
		}

		public static native function getMicrophone(index:int = -1):Microphone;
		public static native function get names():Array;
		[API("667")]
		public static native function get isSupported():Boolean;
		[API("672")]
		public static native function getEnhancedMicrophone(index:int = -1):Microphone;
		public native function set gain(gain:Number):void;
		public native function set rate(level:int):void;
		public native function get rate():int;
		[API("662")]
		public native function set codec(codec:String):void;
		[API("662")]
		public native function get codec():String;
		[API("662")]
		public native function get framesPerPacket():int;
		[API("662")]
		public native function set framesPerPacket(fpp:int):void;
		[API("662")]
		public native function get encodeQuality():int;
		[API("662")]
		public native function set encodeQuality(quality:int):void;
		[API("667")]
		public native function get noiseSuppressionLevel():int;
		[API("667")]
		public native function set noiseSuppressionLevel(level:int):void;
		[API("667")]
		public native function get enableVAD():Boolean;
		[API("667")]
		public native function set enableVAD(isEnabled:Boolean):void;
		public native function setSilenceLevel(silenceLevel:Number, timeout:int = -1):void;
		public native function setUseEchoSuppression(isEchoSuppressed:Boolean):void;
		public native function get activityLevel():Number;
		public native function get gain():Number;
		public native function get index():int;
		public native function get muted():Boolean;
		public native function get name():String;
		public native function get silenceLevel():Number;
		public native function get silenceTimeout():int;
		public native function get useEchoSuppression():Boolean;
		public native function setLoopBack(isLooped:Boolean = true):void;
		public native function get soundTransform():SoundTransform;
		public native function set soundTransform(tf:SoundTransform):void;
		[API("672")]
		public native function get enhancedOptions():MicrophoneEnhancedOptions;
		[API("672")]
		public native function set enhancedOptions(params:MicrophoneEnhancedOptions):void;
	}
}
