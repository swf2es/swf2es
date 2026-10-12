// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/ui/GameInput.ts.

package flash.ui
{
	import flash.events.EventDispatcher;

	[API("688")]
	public final class GameInput extends EventDispatcher
	{
		public function GameInput()
		{
		}

		public static native function getDeviceAt(index:int):GameInputDevice;

		public static native function get numDevices():int;

		public static native function get isSupported():Boolean;
	}
}
