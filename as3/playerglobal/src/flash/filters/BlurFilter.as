// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/filters/BlurFilter.ts.

package flash.filters
{
	public final class BlurFilter extends BitmapFilter
	{
		public function BlurFilter(blurX:Number = 4, blurY:Number = 4, quality:int = 1)
		{
		}

		public native function get blurX():Number;
		public native function set blurX(arg0:Number):void;
		public native function get blurY():Number;
		public native function set blurY(arg0:Number):void;
		public native function get quality():int;
		public native function set quality(arg0:int):void;
		override public native function clone():BitmapFilter;
	}
}
