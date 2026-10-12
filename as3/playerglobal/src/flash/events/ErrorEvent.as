// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/ErrorEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	public class ErrorEvent extends TextEvent
	{
		public static const ERROR:String = "error";

		private var _errorID:int;

		public function ErrorEvent(
				type:String,
				bubbles:Boolean = false,
				cancelable:Boolean = false,
				text:String = "",
				id:int = 0
			)
		{
			super(type, bubbles, cancelable, text);
			this._errorID = id;
		}

		[API("661", "667")]
		public function get errorID():int
		{
			return this._errorID;
		}

		override public function clone():Event
		{
			return new ErrorEvent(
					this.type,
					this.bubbles,
					this.cancelable,
					this.text,
					this._errorID
				);
		}

		override public function toString():String
		{
			const fields:Array = ["ErrorEvent", "type", "bubbles", "cancelable", "eventPhase", "text"];
			// The error's number where it has one, as Flash's string shows it.
			if (errorID != 0)
			{
				fields.push("errorID");
			}

			return formatToString.apply(this, fields);
		}
	}
}
