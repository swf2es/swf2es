// Its API as Flash Player 32's playerglobal declares it (tools/abc-surface/as3.ts),
// which the oracle's predates (tools/playerglobal.ts, NEWER_CLASSES); the bodies
// are the player's own.

package flash.events
{
	public class VideoTextureEvent extends Event
	{
		// Flash Player marks these SWF 29's (API 706), past the oracle's
		// internal version, so unmarked here (tools/playerglobal.ts, NEWER_CLASSES).
		public static const RENDER_STATE:String = "renderState";

		// Flash Player fills it in, which swf2es does not: its type's default.
		public const codecInfo:String = null;

		private var _status:String;
		private var _colorSpace:String;

		public function VideoTextureEvent(type:String, bubbles:Boolean = false, cancelable:Boolean = false, status:String = null, colorSpace:String = null)
		{
			super(type, bubbles, cancelable);
			_status = status;
			_colorSpace = colorSpace;
		}

		public function get status():String
		{
			return _status;
		}

		public function get colorSpace():String
		{
			return _colorSpace;
		}
	}
}
