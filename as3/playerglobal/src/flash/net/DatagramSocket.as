// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	import flash.events.EventDispatcher;
	import flash.utils.ByteArray;

	[API("668")]
	public class DatagramSocket extends EventDispatcher
	{
		public function DatagramSocket()
		{
		}

		public static native function get isSupported():Boolean;

		public native function bind(arg0:int = 0, arg1:String = "0.0.0.0"):void;

		public native function connect(arg0:String, arg1:int):void;

		public native function receive():void;

		public native function close():void;

		public native function send(arg0:ByteArray, arg1:uint = 0, arg2:uint = 0, arg3:String = null, arg4:int = 0):void;

		public native function get connected():Boolean;

		public native function get bound():Boolean;

		public native function get localAddress():String;

		public native function get localPort():int;

		public native function get remoteAddress():String;

		public native function get remotePort():int;
	}
}
