// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	[API("668")]
	public class InterfaceAddress
	{
		public function InterfaceAddress()
		{
		}

		public native function get address():String;

		public native function set address(arg0:String):void;

		public native function get broadcast():String;

		public native function set broadcast(arg0:String):void;

		public native function get prefixLength():int;

		public native function set prefixLength(arg0:int):void;

		public native function get ipVersion():String;

		public native function set ipVersion(arg0:String):void;
	}
}
