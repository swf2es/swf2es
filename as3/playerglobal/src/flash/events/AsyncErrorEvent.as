// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/AsyncErrorEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	public class AsyncErrorEvent extends ErrorEvent
	{
		public static const ASYNC_ERROR:String = "asyncError";

		public var error:Error;

		public function AsyncErrorEvent(
				type:String,
				bubbles:Boolean = false,
				cancelable:Boolean = false,
				text:String = "",
				error:Error = null
			)
		{
			super(type, bubbles, cancelable, text);
			this.error = error;
		}

		override public function clone():Event
		{
			return new AsyncErrorEvent(
					this.type,
					this.bubbles,
					this.cancelable,
					this.text,
					this.error
				);
		}

		override public function toString():String
		{
			return this.formatToString(
					"AsyncErrorEvent",
					"type",
					"bubbles", "cancelable",
					"eventPhase",
					"text",
					"error"
				);
		}
	}
}
