// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	[API("683")]
	public final class RemoteNotificationEvent extends Event
	{
		public function RemoteNotificationEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:Object = null, arg4:String = null)
		{
			super(arg0);
		}

		public static const NOTIFICATION:String = "notification";
		public static const TOKEN:String = "token";

		public native function get data():Object;

		public native function get tokenId():String;
	}
}
