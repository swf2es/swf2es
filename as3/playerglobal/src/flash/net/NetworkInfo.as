// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	import flash.events.EventDispatcher;

	[API("668")]
	public class NetworkInfo extends EventDispatcher
	{
		public function NetworkInfo()
		{
		}

		public static native function get isSupported():Boolean;
		public static native function get networkInfo():NetworkInfo;
		public native function findInterfaces():Vector.<NetworkInterface>;
	}
}
