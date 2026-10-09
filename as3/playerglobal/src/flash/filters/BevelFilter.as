// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/filters/BevelFilter.ts.

package flash.filters
{
	public final class BevelFilter extends BitmapFilter
	{
		public function BevelFilter(distance:Number = 4, angle:Number = 45, highlightColor:uint = 16777215, highlightAlpha:Number = 1, shadowColor:uint = 0, shadowAlpha:Number = 1, blurX:Number = 4, blurY:Number = 4, strength:Number = 1, quality:int = 1, type:String = "inner", knockout:Boolean = false)
		{
		}

		public native function get distance():Number;
		public native function set distance(arg0:Number):void;
		public native function get angle():Number;
		public native function set angle(arg0:Number):void;
		public native function get highlightColor():uint;
		public native function set highlightColor(arg0:uint):void;
		public native function get highlightAlpha():Number;
		public native function set highlightAlpha(arg0:Number):void;
		public native function get shadowColor():uint;
		public native function set shadowColor(arg0:uint):void;
		public native function get shadowAlpha():Number;
		public native function set shadowAlpha(arg0:Number):void;
		public native function get blurX():Number;
		public native function set blurX(arg0:Number):void;
		public native function get blurY():Number;
		public native function set blurY(arg0:Number):void;
		public native function get knockout():Boolean;
		public native function set knockout(arg0:Boolean):void;
		public native function get quality():int;
		public native function set quality(arg0:int):void;
		public native function get strength():Number;
		public native function set strength(arg0:Number):void;
		public native function get type():String;
		public native function set type(arg0:String):void;
		override public native function clone():BitmapFilter;
	}
}
