// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/filters/ColorMatrixFilter.ts.

package flash.filters
{
	public final class ColorMatrixFilter extends BitmapFilter
	{
		public function ColorMatrixFilter(matrix:Array = null)
		{
		}

		public native function get matrix():Array;

		public native function set matrix(matrix:Array):void;

		override public native function clone():BitmapFilter;
	}
}
