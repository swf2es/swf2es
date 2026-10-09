// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/filters/GlowFilter.ts.

package flash.filters
{
	public final class GlowFilter extends BitmapFilter
	{
		public function GlowFilter(color:uint = 16711680, alpha:Number = 1, blurX:Number = 6, blurY:Number = 6, strength:Number = 2, quality:int = 1, inner:Boolean = false, knockout:Boolean = false)
		{
			this.color = color;
			this.alpha = alpha;
			this.blurX = blurX;
			this.blurY = blurY;
			this.strength = strength;
			this.quality = quality;
			this.inner = inner;
			this.knockout = knockout;
		}

		public native function get color():uint;

		public native function set color(arg0:uint):void;

		public native function get alpha():Number;

		public native function set alpha(arg0:Number):void;

		public native function get blurX():Number;

		public native function set blurX(arg0:Number):void;

		public native function get blurY():Number;

		public native function set blurY(arg0:Number):void;

		public native function get inner():Boolean;

		public native function set inner(arg0:Boolean):void;

		public native function get knockout():Boolean;

		public native function set knockout(arg0:Boolean):void;

		public native function get quality():int;

		public native function set quality(arg0:int):void;

		public native function get strength():Number;

		public native function set strength(arg0:Number):void;

		override public native function clone():BitmapFilter;
	}
}
