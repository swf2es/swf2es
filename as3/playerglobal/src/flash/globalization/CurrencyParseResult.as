// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/globalization/CurrencyParseResult.ts.

package flash.globalization
{
	[API("667")]
	public final class CurrencyParseResult
	{
		public function CurrencyParseResult(value:Number = NaN, symbol:String = "")
		{
			ctor(value, symbol);
		}

		public native function get value():Number;

		public native function get currencyString():String;

		// The player's natives (packages/player/src/playerglobal/flash/globalization/CurrencyParseResult.ts).
		private native function ctor(value:Number, symbol:String):void;
	}
}
