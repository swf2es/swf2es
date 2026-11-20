// Its API as Flash Player 32's playerglobal declares it (tools/abc-surface/as3.ts),
// which the oracle's predates (tools/playerglobal.ts, NEWER_CLASSES); the bodies
// are the player's own.

package flash.media
{
	[API("688")]
	public class AVPlayState
	{
		public static const UNINITIALIZED:int = 0;
		public static const READY:int = 1;
		public static const BUFFERING:int = 2;
		public static const PLAYING:int = 3;
		public static const PAUSED:int = 4;
		public static const EOF:int = 5;
		public static const SUSPENDED:int = 6;
		public static const TRICK_PLAY:int = 7;
		public static const UNRECOVERABLE_ERROR:int = 8;

		private var _state:int;

		public function AVPlayState(state:uint)
		{
			_state = state;
		}

		public function get state():int
		{
			return _state;
		}
	}
}
