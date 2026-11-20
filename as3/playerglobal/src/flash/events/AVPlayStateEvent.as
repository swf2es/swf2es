// Its API as Flash Player 32's playerglobal declares it (tools/abc-surface/as3.ts),
// which the oracle's predates (tools/playerglobal.ts, NEWER_CLASSES); the bodies
// are the player's own.

package flash.events
{
	import flash.media.AVPlayState;

	[API("688")]
	public class AVPlayStateEvent extends Event
	{
		public static const AV_PLAY_STATE:String = "avPlayState";

		private var _playState:AVPlayState;

		public function AVPlayStateEvent(type:String = "avPlayState", bubbles:Boolean = false, cancelable:Boolean = false, state:int = 0)
		{
			super(type, bubbles, cancelable);
			_playState = new AVPlayState(state);
		}

		public function get playState():AVPlayState
		{
			return _playState;
		}
	}
}
