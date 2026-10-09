// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/AVM1Movie.ts.

package flash.display
{
	import flash.utils.ByteArray;
	public class AVM1Movie extends DisplayObject
	{
		public function AVM1Movie()
		{
		}

		public native function call(functionName:String, ...rest):*;

		public native function addCallback(name:String, fn:Function):void;

		// The player's natives (packages/player/src/playerglobal/flash/display/AVM1Movie.ts).
		private native function get _interopAvailable():Boolean;

		private native function _callAS2(arg0:String, arg1:ByteArray):void;

		private native function _setCallAS3(arg0:Function):void;
	}
}
