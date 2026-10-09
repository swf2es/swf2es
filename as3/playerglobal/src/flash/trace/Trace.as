// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/trace/Trace.ts.

package flash.trace
{
	public class Trace
	{
		public function Trace()
		{
		}

		public static const OFF:int = 0;
		public static const METHODS:int = 1;
		public static const METHODS_WITH_ARGS:int = 2;
		public static const METHODS_AND_LINES:int = 3;
		public static const METHODS_AND_LINES_WITH_ARGS:int = 4;
		public static const FILE:* = 1;
		public static const LISTENER:* = 2;
		public static native function setLevel(level:int, target:int = 2):*;
		public static native function getLevel(target:int = 2):int;
		public static native function setListener(func:Function):*;
		public static native function getListener():Function;
	}
}
