// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/automation/StageCaptureEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.automation
{
	import flash.events.Event;

	public class StageCaptureEvent extends Event
	{
		public static const CAPTURE:String = "capture";

		private var _url:String;
		private var _checksum:uint;

		public function StageCaptureEvent(
				type:String,
				bubbles:Boolean = false,
				cancelable:Boolean = false,
				url:String = "",
				checksum:uint = 0
			)
		{
			super(type, bubbles, cancelable);
			this._url = url;
			this._checksum = checksum;
		}

		public function get url():String
		{
			return this._url;
		}

		public function get checksum():uint
		{
			return this._checksum;
		}

		override public function clone():Event
		{
			return new StageCaptureEvent(
					this.type,
					this.bubbles,
					this.cancelable,
					this.url,
					this.checksum
				);
		}

		override public function toString():String
		{
			return this.formatToString(
					"StageCaptureEvent",
					"type",
					"bubbles",
					"cancelable",
					"eventPhase",
					"url",
					"checksum"
				);
		}
	}
}
