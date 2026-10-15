// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/VideoEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	[API("670")]
	public class VideoEvent extends Event
	{
		// Flash Player fills these in, which swf2es does not: their type's default.
		public const codecInfo:String = null;
		public static const RENDER_STATE:String = "renderState";
		public static const RENDER_STATUS_ACCELERATED:String = "accelerated";
		public static const RENDER_STATUS_SOFTWARE:String = "software";
		public static const RENDER_STATUS_UNAVAILABLE:String = "unavailable";

		private var _status:String;

		public function VideoEvent(
				type:String,
				bubbles:Boolean = false,
				cancelable:Boolean = false,
				status:String = null
			)
		{
			super(type, bubbles, cancelable);
			this._status = status;
		}

		public function get status():String
		{
			return this._status;
		}
	}
}
