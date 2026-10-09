// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/UncaughtErrorEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	[API("667")]
	public class UncaughtErrorEvent extends ErrorEvent
	{
		public static const UNCAUGHT_ERROR:String = "uncaughtError";

		private var _error:*;

		public function UncaughtErrorEvent(
				type:String = "uncaughtError",
				bubbles:Boolean = true,
				cancelable:Boolean = true,
				error_in:* = null
			)
		{
			super(type, bubbles, cancelable);
			this._error = error_in;
		}

		override public function clone():Event
		{
			return new UncaughtErrorEvent(this.type, this.bubbles, this.cancelable, this.error);
		}

		override public function toString():String
		{
			return this.formatToString(
					"UncaughtErrorEvent",
					"type",
					"bubbles",
					"cancelable",
					"eventPhase",
					"error"
				);
		}

		public function get error():*
		{
			return this._error;
		}
	}
}
