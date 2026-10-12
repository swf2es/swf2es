// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	[API("661")]
	public class HTMLUncaughtScriptExceptionEvent extends Event
	{
		public function HTMLUncaughtScriptExceptionEvent(arg0:*)
		{
			super(arg0);
		}

		public static const UNCAUGHT_SCRIPT_EXCEPTION:* = "uncaughtScriptException";

		override public native function clone():Event;

		public var exceptionValue:*;

		public native function get stackTrace():Array;

		public native function set stackTrace(arg0:Array):void;
	}
}
