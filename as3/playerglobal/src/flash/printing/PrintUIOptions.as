// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.printing
{
	[API("668")]
	public final class PrintUIOptions
	{
		public function PrintUIOptions()
		{
		}

		public var minPage:uint = 0;
		public var maxPage:uint = 0;
		public var disablePageRange:Boolean = false;
	}
}
