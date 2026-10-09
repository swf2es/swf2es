// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display
{
	import flash.events.EventDispatcher;

	public final class FrameLabel extends EventDispatcher
	{
		public function FrameLabel(name:String, frame:int)
		{
		}

		public native function get name():String;

		public native function get frame():int;
	}
}
