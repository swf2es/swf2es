// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.ui
{
	import flash.utils.ByteArray;

	[API("688")]
	public final class GameInputDevice
	{
		public function GameInputDevice()
		{
		}

		public static const MAX_BUFFER_SIZE:int = 32000;
		public native function getControlAt(arg0:int):GameInputControl;
		public native function get numControls():int;
		public native function startCachingSamples(arg0:int, arg1:Vector.<String>):void;
		public native function get sampleInterval():int;
		public native function set sampleInterval(arg0:int):void;
		public native function stopCachingSamples():void;
		public native function getCachedSamples(arg0:ByteArray, arg1:Boolean = false):int;
		public native function get enabled():Boolean;
		public native function set enabled(arg0:Boolean):void;
		public native function get id():String;
		public native function get name():String;
	}
}
