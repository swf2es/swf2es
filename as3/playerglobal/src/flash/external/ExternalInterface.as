// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/external/ExternalInterface.ts.

package flash.external
{
	public final class ExternalInterface
	{
		public function ExternalInterface()
		{
		}

		public static native function get available():Boolean;
		public static var marshallExceptions:Boolean = false;
		public static native function addCallback(functionName:String, closure:Function):void;
		public static native function call(functionName:String, ...arguments):*;
		public static native function get objectID():String;
	}
}
