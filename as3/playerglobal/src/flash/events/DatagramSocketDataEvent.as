// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	import flash.utils.ByteArray;

	[API("668")]
	public class DatagramSocketDataEvent extends Event
	{
		public function DatagramSocketDataEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:String = "", arg4:int = 0, arg5:String = "", arg6:int = 0, arg7:ByteArray = null)
		{
			super(arg0);
		}

		public static const DATA:String = "data";

		override public native function clone():Event;

		override public native function toString():String;

		public native function get srcAddress():String;

		public native function set srcAddress(arg0:String):void;

		public native function get srcPort():int;

		public native function set srcPort(arg0:int):void;

		public native function get dstAddress():String;

		public native function set dstAddress(arg0:String):void;

		public native function get dstPort():int;

		public native function set dstPort(arg0:int):void;

		public native function get data():ByteArray;

		public native function set data(arg0:ByteArray):void;
	}
}
