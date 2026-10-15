// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	import flash.events.EventDispatcher;

	[API("672")]
	public class NetMonitor extends EventDispatcher
	{
		public function NetMonitor()
		{
		}

		public native function listStreams():Vector.<NetStream>;
	}
}
