// Its API as Flash Player 32's playerglobal declares it (tools/abc-surface/as3.ts),
// which the oracle's predates (tools/playerglobal.ts, NEWER_CLASSES); the bodies
// are the player's own.

package flash.events
{
	import flash.utils.Dictionary;

	[API("688")]
	public class AVLoadInfoEvent extends Event
	{
		public static const AV_LOAD_INFO:* = "avLoadInfo";

		private var _loadInfo:Dictionary;

		public function AVLoadInfoEvent(type:String = "avLoadInfo", bubbles:Boolean = false, cancelable:Boolean = false, loadInfo:Dictionary = null)
		{
			super(type, bubbles, cancelable);
			_loadInfo = loadInfo;
		}

		public function get loadInfo():Dictionary
		{
			return _loadInfo;
		}
	}
}
