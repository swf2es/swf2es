// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net.dns
{
	[API("668")]
	public class MXRecord extends ResourceRecord
	{
		public function MXRecord()
		{
		}

		public native function get exchange():String;
		public native function set exchange(arg0:String):void;
		public native function get preference():int;
		public native function set preference(arg0:int):void;
	}
}
