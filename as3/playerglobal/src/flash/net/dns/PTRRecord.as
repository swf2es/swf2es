// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net.dns
{
	[API("668")]
	public class PTRRecord extends ResourceRecord
	{
		public function PTRRecord()
		{
		}

		public native function get ptrdName():String;

		public native function set ptrdName(arg0:String):void;
	}
}
