// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.ui
{
	import flash.display.BitmapData;
	import flash.geom.Point;

	[API("670")]
	public final class MouseCursorData
	{
		public function MouseCursorData()
		{
		}

		public native function get data():Vector.<BitmapData>;
		public native function set data(value:Vector.<BitmapData>):void;
		public native function get hotSpot():Point;
		public native function set hotSpot(value:Point):void;
		public native function get frameRate():Number;
		public native function set frameRate(value:Number):void;
	}
}
