// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/AVM1Movie.ts.

package flash.display
{
	public class AVM1Movie extends DisplayObject
	{
		public function AVM1Movie()
		{
		}

		public native function call(functionName:String, ...rest):*;

		public native function addCallback(name:String, fn:Function):void;
	}
}
