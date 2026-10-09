// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.sensors
{
	import flash.events.EventDispatcher;

	[API("668")]
	public class Geolocation extends EventDispatcher
	{
		public function Geolocation()
		{
		}

		public static native function get isSupported():Boolean;
		public native function setRequestedUpdateInterval(arg0:Number):void;
		public native function get muted():Boolean;
	}
}
