// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/system/System.ts.

package flash.system
{
	public final class System
	{
		public function System()
		{
		}

		public static native function get ime():IME;

		public static native function setClipboard(string:String):void;

		public static native function get totalMemory():uint;

		public static native function get totalMemoryNumber():Number;

		public static native function get freeMemory():Number;

		public static native function get privateMemory():Number;

		[API("674")]
		public static native function get processCPUUsage():Number;

		public static native function get useCodePage():Boolean;

		public static native function set useCodePage(arg0:Boolean):void;

		public static native function get vmVersion():String;

		public static native function pause():void;

		public static native function resume():void;

		public static native function exit(code:uint):void;

		public static native function gc():void;

		public static native function pauseForGCIfCollectionImminent(imminence:Number = 0.75):void;

		[API("666", "667")]
		public static native function disposeXML(node:XML):void;
	}
}
