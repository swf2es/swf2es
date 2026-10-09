// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/TimerEvent.ts.

package flash.events
{
	public class TimerEvent extends Event
	{
		public function TimerEvent(type:String, bubbles:Boolean = false, cancelable:Boolean = false)
		{
			super(type, bubbles, cancelable);
		}

		public static const TIMER:String = "timer";
		public static const TIMER_COMPLETE:String = "timerComplete";

		override public function clone():Event
		{
			return new TimerEvent(type, bubbles, cancelable);
		}

		override public native function toString():String;

		public native function updateAfterEvent():void;
	}
}
