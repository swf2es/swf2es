// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/ui/Multitouch.ts.

package flash.ui
{
	[API("667")]
	public final class Multitouch
	{
		public function Multitouch()
		{
		}

		public static native function get inputMode():String;

		public static native function set inputMode(arg0:String):void;

		public static native function get supportsTouchEvents():Boolean;

		public static native function get supportsGestureEvents():Boolean;

		public static native function get supportedGestures():Vector.<String>;

		public static native function get maxTouchPoints():int;

		[API("675")]
		public static native function get mapTouchToMouse():Boolean;

		[API("675")]
		public static native function set mapTouchToMouse(arg0:Boolean):void;
	}
}
