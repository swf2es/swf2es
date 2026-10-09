// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	[API("668")]
	public class NativeProcessExitEvent extends Event
	{
		public function NativeProcessExitEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:Number = NaN)
		{
			super(arg0);
		}

		public static const EXIT:String = "exit";

		override public native function clone():Event;

		override public native function toString():String;

		public native function get exitCode():Number;

		public native function set exitCode(arg0:Number):void;
	}
}
