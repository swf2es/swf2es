// The timers behind setInterval and setTimeout, by the id each returned:
// internal to flash.utils, which SWFs do not see.

package flash.utils
{
	import flash.events.TimerEvent;

	internal class IntervalTimer extends Timer
	{
		private static var _timers:Object = {};
		private static var _lastId:uint = 0;

		private var _id:uint;
		private var _closure:Function;
		private var _args:Array;

		public function IntervalTimer(closure:Function, delay:Number, repeats:Boolean, args:Array)
		{
			super(delay, repeats ? 0 : 1);
			_id = ++_lastId;
			_closure = closure;
			_args = args;
			_timers[_id] = this;
			addEventListener(TimerEvent.TIMER, fire);
			start();
		}

		public function get id():uint
		{
			return _id;
		}

		public static function clear(id:uint):void
		{
			const timer:IntervalTimer = _timers[id];
			if (timer != null)
			{
				timer.stop();
				delete _timers[id];
			}
		}

		private function fire(event:TimerEvent):void
		{
			// A timeout is gone once it has fired, before its closure runs.
			if (repeatCount != 0)
			{
				delete _timers[_id];
			}

			_closure.apply(null, _args);
		}
	}
}
