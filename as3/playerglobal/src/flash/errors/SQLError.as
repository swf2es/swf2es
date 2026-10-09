// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.errors
{
	[API("661")]
	public class SQLError extends Error
	{
		public function SQLError(arg0:String, arg1:String = "", arg2:String = "", arg3:int = 0, arg4:int = -1, arg5:Array = null)
		{
		}

		public native function get details():String;
		public native function get detailID():int;
		public native function get detailArguments():Array;
		public native function get operation():String;
		public native function toString():String;
	}
}
