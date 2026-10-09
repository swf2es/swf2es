// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/globalization/NumberParseResult.ts.

package flash.globalization
{
	[API("667")]
	public final class NumberParseResult
	{
		public function NumberParseResult(value:Number = NaN, startIndex:int = 2147483647, endIndex:int = 2147483647)
		{
			ctor(value, startIndex, endIndex);
		}

		public native function get value():Number;

		public native function get startIndex():int;

		public native function get endIndex():int;

		// The player's natives (packages/player/src/playerglobal/flash/globalization/NumberParseResult.ts).
		private native function ctor(value:Number, startIndex:int, endIndex:int):void;
	}
}
