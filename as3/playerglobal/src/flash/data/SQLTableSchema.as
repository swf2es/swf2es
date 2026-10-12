// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.data
{
	[API("661")]
	public class SQLTableSchema extends SQLSchema
	{
		public function SQLTableSchema(arg0:String, arg1:String, arg2:String, arg3:Array)
		{
			super(arg0, arg1, arg2);
		}

		public native function get columns():Array;
	}
}
