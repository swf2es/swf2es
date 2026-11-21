// Its API as Flash Player 32's playerglobal declares it (tools/abc-surface/as3.ts),
// which the oracle's predates (tools/playerglobal.ts, NEWER_CLASSES); the bodies
// are the player's own.

package flash.events
{
	import flash.media.AVResult;

	[API("688")]
	public class AVStatusEvent extends Event
	{
		public static const AV_STATUS:String = "avStatus";
		public static const LOAD_COMPLETE:String = "LoadComplete";
		public static const MANIFEST_UPDATE:String = "ManifestUpdate";
		public static const INSERTION_COMPLETE:String = "InsertionComplete";
		public static const ERROR:String = "Error";
		public static const WARNING:String = "Warning";
		public static const DIMENSION_CHANGE:String = "DimensionChange";
		public static const DECODER_TYPE:String = "DecoderType";
		public static const RENDER_TYPE:String = "RenderType";
		public static const SEEK_COMPLETE:String = "SeekComplete";
		public static const STEP_COMPLETE:String = "StepComplete";
		public static const STREAM_SWITCH:String = "StreamSwitch";
		public static const PLAY_STATE:String = "PlayState";
		public static const BUFFER_STATE:String = "BufferState";
		public static const TRICKPLAY_ENDED:String = "TrickPlayEnded";
		public static const BACKGROUND_MANIFEST_ERROR:String = "BackgroundManifestError";
		public static const BACKGROUND_MANIFEST_WARNING:String = "BackgroundManifestWarning";

		private var _notificationType:String;
		private var _result:AVResult;
		private var _description:String;

		public function AVStatusEvent(type:String = "avStatus", bubbles:Boolean = false, cancelable:Boolean = false, notificationType:String = "", result:int = 0, description:String = "")
		{
			super(type, bubbles, cancelable);
			_notificationType = notificationType;
			_result = new AVResult(result);
			_description = description;
		}

		public function get result():AVResult
		{
			return _result;
		}

		public function get notificationType():String
		{
			return _notificationType;
		}

		public function get description():String
		{
			return _description;
		}
	}
}
