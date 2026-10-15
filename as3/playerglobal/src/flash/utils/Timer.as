// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/utils/Timer.ts. The counting
// follows Ruffle's (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/
// flash/utils/Timer.as: MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and
// Ruffle contributors.

package flash.utils
{
	import flash.events.EventDispatcher;
	import flash.events.TimerEvent;

	public class Timer extends EventDispatcher
	{
		private var _delay:Number;
		private var _repeatCount:int;
		private var _currentCount:int;

		public function Timer(delay:Number, repeatCount:int = 0)
		{
			checkDelay(delay);
			_delay = delay;
			_repeatCount = repeatCount;
		}

		public function get delay():Number
		{
			return _delay;
		}

		public function set delay(value:Number):void
		{
			checkDelay(value);
			_delay = value;
			// A running timer starts over with the new delay.
			if (running)
			{
				_start(_delay, tick);
			}
		}

		public function get repeatCount():int
		{
			return _repeatCount;
		}

		public function set repeatCount(value:int):void
		{
			_repeatCount = value;
			if (_repeatCount != 0 && _currentCount >= _repeatCount)
			{
				stop();
			}
		}

		public function get currentCount():int
		{
			return _currentCount;
		}

		public native function get running():Boolean;

		public function start():void
		{
			if (!running)
			{
				_start(_delay, tick);
			}
		}

		public function reset():void
		{
			stop();
			_currentCount = 0;
		}

		public native function stop():void;

		private static function checkDelay(delay:Number):void
		{
			if (!isFinite(delay) || delay < 0)
			{
				Error.throwError(RangeError, 2066);
			}
		}

		// What the player calls each time the timer fires.
		private function tick():void
		{
			_currentCount++;
			_timerDispatch();
			if (_repeatCount != 0 && _currentCount >= _repeatCount)
			{
				stop();
				dispatchEvent(new TimerEvent(TimerEvent.TIMER_COMPLETE));
			}
		}

		// The player's natives (packages/player/src/playerglobal/flash/utils/Timer.ts).
		private native function _start(delay:Number, closure:Function):void;

		private native function _timerDispatch():void;
	}
}
