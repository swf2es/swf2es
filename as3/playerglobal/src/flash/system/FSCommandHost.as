// The player's fscommand, on a class of flash.system's own that SWFs do not
// see; native in packages/player/src/playerglobal/flash/system/FSCommandHost.ts.

package flash.system
{
	internal class FSCommandHost
	{
		public static native function _fscommand(command:String, args:String):void;
	}
}
