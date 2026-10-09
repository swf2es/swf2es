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

		// The player's natives (packages/player/src/playerglobal/flash/external/ExternalInterface.ts).
		private static native function _initJS():void;

		private static native function _getPropNames(object:Object):Array;

		private static native function get activeX():Boolean;

		private static native function _addCallback(name:String, closure:Function, remove:Boolean):void;

		private static native function _evalJS(source:String):String;

		private static native function _callOut(request:String):String;

		private static native function _quotedStringFromError(error:Error):String;

		private static native function _quotedStringFromString(value:String):String;
	}
}
