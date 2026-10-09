// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.data
{
	[API("661")]
	public class SQLSchemaResult
	{
		public function SQLSchemaResult(arg0:Array, arg1:Array, arg2:Array, arg3:Array)
		{
		}

		public native function get indices():Array;

		public native function get tables():Array;

		public native function get triggers():Array;

		public native function get views():Array;
	}
}
