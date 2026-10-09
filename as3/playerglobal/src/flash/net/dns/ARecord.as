// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net.dns
{
	[API("668")]
	public class ARecord extends ResourceRecord
	{
		public function ARecord()
		{
		}

		public native function get address():String;

		public native function set address(arg0:String):void;
	}
}
