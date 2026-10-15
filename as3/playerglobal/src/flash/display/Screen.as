// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display
{
	import flash.events.EventDispatcher;
	import flash.geom.Rectangle;

	[API("661")]
	public final class Screen extends EventDispatcher
	{
		public function Screen()
		{
		}

		public static native function get screens():Array;

		public static native function get mainScreen():Screen;

		public static native function getScreensForRectangle(arg0:Rectangle):Array;

		public native function get bounds():Rectangle;

		public native function get visibleBounds():Rectangle;

		public native function get colorDepth():int;
	}
}
