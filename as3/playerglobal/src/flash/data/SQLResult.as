// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.data
{
	[API("661")]
	public class SQLResult
	{
		public function SQLResult(arg0:Array = null, arg1:Number = 0, arg2:Boolean = true, arg3:Number = 0)
		{
		}

		public native function get complete():Boolean;

		public native function get data():Array;

		public native function get rowsAffected():Number;

		public native function get lastInsertRowID():Number;
	}
}
