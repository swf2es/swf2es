// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net.dns
{
	[API("668")]
	public class ResourceRecord
	{
		public function ResourceRecord()
		{
		}

		public native function get name():String;
		public native function set name(arg0:String):void;
		public native function get ttl():int;
		public native function set ttl(arg0:int):void;
	}
}
