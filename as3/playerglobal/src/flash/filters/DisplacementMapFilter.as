// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/filters/DisplacementMapFilter.ts.

package flash.filters
{
	import flash.display.BitmapData;
	import flash.geom.Point;

	public final class DisplacementMapFilter extends BitmapFilter
	{
		public function DisplacementMapFilter(mapBitmap:BitmapData = null, mapPoint:Point = null, componentX:uint = 0, componentY:uint = 0, scaleX:Number = 0, scaleY:Number = 0, mode:String = "wrap", color:uint = 0, alpha:Number = 0)
		{
			// Null keeps the default.
			if (mapBitmap != null)
			{
				this.mapBitmap = mapBitmap;
			}

			if (mapPoint != null)
			{
				this.mapPoint = mapPoint;
			}

			this.componentX = componentX;
			this.componentY = componentY;
			this.scaleX = scaleX;
			this.scaleY = scaleY;
			this.mode = mode;
			this.color = color;
			this.alpha = alpha;
		}

		public native function get mapBitmap():BitmapData;

		public native function set mapBitmap(arg0:BitmapData):void;

		public native function get mapPoint():Point;

		public native function set mapPoint(arg0:Point):void;

		public native function get componentX():uint;

		public native function set componentX(arg0:uint):void;

		public native function get componentY():uint;

		public native function set componentY(arg0:uint):void;

		public native function get scaleX():Number;

		public native function set scaleX(arg0:Number):void;

		public native function get scaleY():Number;

		public native function set scaleY(arg0:Number):void;

		public native function get mode():String;

		public native function set mode(arg0:String):void;

		public native function get color():uint;

		public native function set color(arg0:uint):void;

		public native function get alpha():Number;

		public native function set alpha(arg0:Number):void;

		override public function clone():BitmapFilter
		{
			return new DisplacementMapFilter(mapBitmap, mapPoint, componentX, componentY, scaleX, scaleY, mode, color, alpha);
		}
	}
}
