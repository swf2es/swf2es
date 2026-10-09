// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.data
{
	[API("661")]
	public class SQLSchema
	{
		public function SQLSchema(arg0:String, arg1:String, arg2:String)
		{
		}

		public native function get database():String;
		public native function get name():String;
		public native function get sql():String;
	}
}
