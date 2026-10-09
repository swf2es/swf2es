// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.system
{
	import flash.events.EventDispatcher;

	[API("667")]
	public class SystemUpdater extends EventDispatcher
	{
		public function SystemUpdater()
		{
		}

		public native function update(arg0:String):void;
		public native function cancel():void;
	}
}
