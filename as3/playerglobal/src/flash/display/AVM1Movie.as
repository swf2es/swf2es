// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/AVM1Movie.ts.

package flash.display
{
	import flash.utils.ByteArray;
	public class AVM1Movie extends DisplayObject
	{
		// The AS3 functions an AVM1 movie may call, by name.
		private var _callbacks:Object = {};

		public function AVM1Movie()
		{
			_setCallAS3(callFromAVM1);
		}

		public function call(functionName:String, ...args):*
		{
			checkInterop();
			const bytes:ByteArray = new ByteArray();
			bytes.writeObject(args);
			_callAS2(functionName, bytes);
			return undefined;
		}

		public function addCallback(name:String, fn:Function):void
		{
			checkInterop();
			_callbacks[name] = fn;
		}

		// Throws #2014 while the AVM1 movie cannot be reached, as the player's never can.
		private function checkInterop():void
		{
			if (!_interopAvailable)
			{
				Error.throwError(Error, 2014);
			}
		}

		private function callFromAVM1(name:String, args:Array):*
		{
			const fn:Function = _callbacks[name];
			return fn != null ? fn.apply(null, args) : undefined;
		}

		// The player's natives (packages/player/src/playerglobal/flash/display/AVM1Movie.ts).
		private native function get _interopAvailable():Boolean;

		private native function _callAS2(arg0:String, arg1:ByteArray):void;

		private native function _setCallAS3(arg0:Function):void;
	}
}
