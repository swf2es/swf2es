// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net.dns
{
	import flash.events.EventDispatcher;

	[API("668")]
	public class DNSResolver extends EventDispatcher
	{
		public function DNSResolver()
		{
		}

		public static native function get isSupported():Boolean;

		public native function lookup(arg0:String, arg1:Class):void;
	}
}
