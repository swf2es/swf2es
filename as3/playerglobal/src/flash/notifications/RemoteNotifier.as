// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.notifications
{
	import flash.events.EventDispatcher;

	[API("683")]
	public class RemoteNotifier extends EventDispatcher
	{
		public function RemoteNotifier()
		{
		}

		public static native function get supportedNotificationStyles():Vector.<String>;
		public native function subscribe(arg0:RemoteNotifierSubscribeOptions = null):void;
		public native function unsubscribe():void;
	}
}
