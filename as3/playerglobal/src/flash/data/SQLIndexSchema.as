// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.data
{
	[API("661")]
	public class SQLIndexSchema extends SQLSchema
	{
		public function SQLIndexSchema(arg0:String, arg1:String, arg2:String, arg3:String)
		{
			super(arg0, arg1, arg2);
		}

		public native function get table():String;
	}
}
