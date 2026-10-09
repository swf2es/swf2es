// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.notifications
{
	[API("683")]
	public final class RemoteNotifierSubscribeOptions
	{
		public function RemoteNotifierSubscribeOptions()
		{
		}

		public native function get notificationStyles():Vector.<String>;
		public native function set notificationStyles(arg0:Vector.<String>):void;
	}
}
