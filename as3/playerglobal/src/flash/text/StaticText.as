// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/text/StaticText.ts.

package flash.text
{
	import flash.display.DisplayObject;

	public final class StaticText extends DisplayObject
	{
		public function StaticText()
		{
		}

		public native function get text():String;
	}
}
