// Its API as Flash Player 32's playerglobal declares it (tools/abc-surface/as3.ts),
// which the oracle's predates (tools/playerglobal.ts, NEWER_CLASSES); the bodies
// are the player's own.

package flash.events
{
	[API("688")]
	public class AVPauseAtPeriodEndEvent extends Event
	{
		public static const AV_PAUSE_AT_PERIOD_END:String = "avPauseAtPeriodEnd";

		private var _userData:int;

		public function AVPauseAtPeriodEndEvent(type:String = "avPauseAtPeriodEnd", bubbles:Boolean = false, cancelable:Boolean = false, userData:int = 0)
		{
			super(type, bubbles, cancelable);
			_userData = userData;
		}

		public function get userData():int
		{
			return _userData;
		}
	}
}
