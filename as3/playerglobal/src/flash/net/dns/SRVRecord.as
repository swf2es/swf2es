// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net.dns
{
	[API("668")]
	public class SRVRecord extends ResourceRecord
	{
		public function SRVRecord()
		{
		}

		public native function get priority():int;

		public native function set priority(arg0:int):void;

		public native function get weight():int;

		public native function set weight(arg0:int):void;

		public native function get port():int;

		public native function set port(arg0:int):void;

		public native function get target():String;

		public native function set target(arg0:String):void;
	}
}
