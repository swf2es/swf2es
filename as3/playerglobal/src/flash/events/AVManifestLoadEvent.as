// Its API as Flash Player 32's playerglobal declares it (tools/abc-surface/as3.ts),
// which the oracle's predates (tools/playerglobal.ts, NEWER_CLASSES); the bodies
// are the player's own.

package flash.events
{
	import flash.media.AVResult;

	[API("688")]
	public class AVManifestLoadEvent extends Event
	{
		public static const AV_MANIFEST_LOAD:String = "avManifestLoad";

		private var _result:AVResult;
		private var _userData:int;
		private var _handle:int;
		private var _duration:Number;

		public function AVManifestLoadEvent(type:String = "avManifestLoad", bubbles:Boolean = false, cancelable:Boolean = false, result:int = 0, userData:int = 0, handle:int = 0, duration:Number = 0)
		{
			super(type, bubbles, cancelable);
			_result = new AVResult(result);
			_userData = userData;
			_handle = handle;
			_duration = duration;
		}

		public function get result():AVResult
		{
			return _result;
		}

		public function get userData():int
		{
			return _userData;
		}

		public function get handle():int
		{
			return _handle;
		}

		public function get duration():Number
		{
			return _duration;
		}
	}
}
