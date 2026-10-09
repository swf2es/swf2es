// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/StageVideoAvailabilityEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	[API("670")]
	public class StageVideoAvailabilityEvent extends Event
	{
		public static const STAGE_VIDEO_AVAILABILITY:String = "stageVideoAvailability";

		public const driver:String;
		public const reason:String;

		private var _availability:String;

		public function StageVideoAvailabilityEvent(
				type:String,
				bubbles:Boolean = false,
				cancelable:Boolean = false,
				availability:String = null
			)
		{
			super(type, bubbles, cancelable);
			this._availability = availability;
		}

		public function get availability():String
		{
			return this._availability;
		}
	}
}
