// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/profiler/Telemetry.ts.

package flash.profiler
{
	[API("678")]
	public final class Telemetry
	{
		public function Telemetry()
		{
		}

		public static native function get spanMarker():Number;

		public static native function get connected():Boolean;

		public static native function sendMetric(metric:String, value:*):void;

		public static native function sendSpanMetric(metric:String, startSpanMarker:Number, value:* = null):void;

		public static native function registerCommandHandler(commandName:String, handler:Function):Boolean;

		public static native function unregisterCommandHandler(commandName:String):Boolean;
	}
}
