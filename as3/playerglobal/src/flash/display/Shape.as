// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/Shape.ts.

package flash.display
{
	public class Shape extends DisplayObject
	{
		public function Shape()
		{
		}

		public native function get graphics():Graphics;
	}
}
