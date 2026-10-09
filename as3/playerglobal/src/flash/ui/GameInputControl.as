// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.ui
{
	import flash.events.EventDispatcher;

	[API("688")]
	public dynamic class GameInputControl extends EventDispatcher
	{
		public function GameInputControl()
		{
		}

		public native function get value():Number;
		public native function get minValue():Number;
		public native function get maxValue():Number;
		public native function get device():GameInputDevice;
		public native function get id():String;
	}
}
