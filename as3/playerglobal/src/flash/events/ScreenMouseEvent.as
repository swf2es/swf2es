// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	[API("661")]
	public class ScreenMouseEvent extends MouseEvent
	{
		public function ScreenMouseEvent(arg0:String, arg1:Boolean = false, arg2:Boolean = false, arg3:Number = void 0, arg4:Number = void 0, arg5:Boolean = false, arg6:Boolean = false, arg7:Boolean = false, arg8:Boolean = false, arg9:Boolean = false, arg10:Boolean = false)
		{
			super(arg0);
		}

		public static const CLICK:String = "click";
		public static const MOUSE_DOWN:String = "mouseDown";
		public static const MOUSE_UP:String = "mouseUp";
		public static const RIGHT_CLICK:String = "rightClick";
		public static const RIGHT_MOUSE_DOWN:String = "rightMouseDown";
		public static const RIGHT_MOUSE_UP:String = "rightMouseUp";
		override public native function clone():Event;
		override public native function toString():String;
		public native function get screenX():Number;
		public native function get screenY():Number;
	}
}
