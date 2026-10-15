// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	import flash.net.Socket;

	[API("668")]
	public class ServerSocketConnectEvent extends Event
	{
		public function ServerSocketConnectEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:Socket = null)
		{
			super(arg0);
		}

		public static const CONNECT:String = "connect";

		override public native function clone():Event;

		override public native function toString():String;

		public native function get socket():Socket;

		public native function set socket(arg0:Socket):void;
	}
}
