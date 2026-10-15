// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	import flash.errors.SQLError;

	[API("661")]
	public class SQLErrorEvent extends ErrorEvent
	{
		public function SQLErrorEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:SQLError = null)
		{
			super(arg0);
		}

		public static const ERROR:String = "error";

		public native function get error():SQLError;

		override public native function clone():Event;

		override public native function toString():String;
	}
}
