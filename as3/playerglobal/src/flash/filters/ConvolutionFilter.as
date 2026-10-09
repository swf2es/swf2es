// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/filters/ConvolutionFilter.ts.

package flash.filters
{
	public class ConvolutionFilter extends BitmapFilter
	{
		public function ConvolutionFilter(matrixX:Number = 0, matrixY:Number = 0, matrix:Array = null, divisor:Number = 1, bias:Number = 0, preserveAlpha:Boolean = true, clamp:Boolean = true, color:uint = 0, alpha:Number = 0)
		{
			this.matrixX = matrixX;
			this.matrixY = matrixY;
			// Null keeps the default.
			if (matrix != null)
			{
				this.matrix = matrix;
			}

			this.divisor = divisor;
			this.bias = bias;
			this.preserveAlpha = preserveAlpha;
			this.clamp = clamp;
			this.color = color;
			this.alpha = alpha;
		}

		public native function get matrix():Array;

		public native function set matrix(arg0:Array):void;

		public native function get matrixX():Number;

		public native function set matrixX(arg0:Number):void;

		public native function get matrixY():Number;

		public native function set matrixY(arg0:Number):void;

		public native function get divisor():Number;

		public native function set divisor(arg0:Number):void;

		public native function get bias():Number;

		public native function set bias(arg0:Number):void;

		public native function get preserveAlpha():Boolean;

		public native function set preserveAlpha(arg0:Boolean):void;

		public native function get clamp():Boolean;

		public native function set clamp(arg0:Boolean):void;

		public native function get color():uint;

		public native function set color(arg0:uint):void;

		public native function get alpha():Number;

		public native function set alpha(arg0:Number):void;

		override public native function clone():BitmapFilter;
	}
}
