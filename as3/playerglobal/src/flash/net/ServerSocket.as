// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	import flash.events.EventDispatcher;

	[API("668")]
	public class ServerSocket extends EventDispatcher
	{
		public function ServerSocket()
		{
		}

		public static native function get isSupported():Boolean;
		public native function bind(arg0:int = 0, arg1:String = "0.0.0.0"):void;
		public native function close():void;
		public native function listen(arg0:int = 0):void;
		public native function get localAddress():String;
		public native function get localPort():int;
		public native function get listening():Boolean;
		public native function get bound():Boolean;
	}
}
