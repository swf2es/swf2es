// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/ui/Mouse.ts.

package flash.ui
{
	public final class Mouse
	{
		public function Mouse()
		{
		}

		public static native function hide():void;

		public static native function show():void;

		[API("667")]
		public static native function get supportsCursor():Boolean;

		[API("662")]
		public static native function get cursor():String;

		[API("662")]
		public static native function set cursor(value:String):void;

		[API("670")]
		public static native function registerCursor(name:String, cursor:MouseCursorData):void;

		[API("670")]
		public static native function unregisterCursor(name:String):void;

		[API("670")]
		public static native function get supportsNativeCursor():Boolean;
	}
}
