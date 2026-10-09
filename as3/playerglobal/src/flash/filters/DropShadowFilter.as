// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/filters/DropShadowFilter.ts.

package flash.filters
{
	public final class DropShadowFilter extends BitmapFilter
	{
		public function DropShadowFilter(distance:Number = 4, angle:Number = 45, color:uint = 0, alpha:Number = 1, blurX:Number = 4, blurY:Number = 4, strength:Number = 1, quality:int = 1, inner:Boolean = false, knockout:Boolean = false, hideObject:Boolean = false)
		{
			this.distance = distance;
			this.angle = angle;
			this.color = color;
			this.alpha = alpha;
			this.blurX = blurX;
			this.blurY = blurY;
			this.strength = strength;
			this.quality = quality;
			this.inner = inner;
			this.knockout = knockout;
			this.hideObject = hideObject;
		}

		public native function get distance():Number;

		public native function set distance(arg0:Number):void;

		public native function get angle():Number;

		public native function set angle(arg0:Number):void;

		public native function get color():uint;

		public native function set color(arg0:uint):void;

		public native function get alpha():Number;

		public native function set alpha(arg0:Number):void;

		public native function get blurX():Number;

		public native function set blurX(arg0:Number):void;

		public native function get blurY():Number;

		public native function set blurY(arg0:Number):void;

		public native function get hideObject():Boolean;

		public native function set hideObject(arg0:Boolean):void;

		public native function get inner():Boolean;

		public native function set inner(arg0:Boolean):void;

		public native function get knockout():Boolean;

		public native function set knockout(arg0:Boolean):void;

		public native function get quality():int;

		public native function set quality(arg0:int):void;

		public native function get strength():Number;

		public native function set strength(arg0:Number):void;

		override public function clone():BitmapFilter
		{
			return new DropShadowFilter(distance, angle, color, alpha, blurX, blurY, strength, quality, inner, knockout, hideObject);
		}
	}
}
