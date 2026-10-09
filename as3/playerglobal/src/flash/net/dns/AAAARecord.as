// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net.dns
{
	[API("668")]
	public class AAAARecord extends ResourceRecord
	{
		public function AAAARecord()
		{
		}

		public native function get address():String;

		public native function set address(arg0:String):void;
	}
}
