// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/utils/Timer.ts.

package flash.utils
{
	import flash.events.EventDispatcher;

	public class Timer extends EventDispatcher
	{
		public function Timer(delay:Number, repeatCount:int = 0)
		{
		}

		public native function get delay():Number;

		public native function get repeatCount():int;

		public native function set repeatCount(value:int):void;

		public native function get currentCount():int;

		public native function get running():Boolean;

		public native function set delay(value:Number):void;

		public native function start():void;

		public native function reset():void;

		public native function stop():void;

		// The player's natives (packages/player/src/playerglobal/flash/utils/Timer.ts).
		private native function _start(delay:Number, closure:Function):void;

		private native function _timerDispatch():void;
	}
}
