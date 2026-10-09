// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/SecurityErrorEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	public class SecurityErrorEvent extends ErrorEvent
	{
		public static const SECURITY_ERROR:String = "securityError";

		public function SecurityErrorEvent(
				type:String,
				bubbles:Boolean = false,
				cancelable:Boolean = false,
				text:String = "",
				id:int = 0
			)
		{
			super(type, bubbles, cancelable, text, id);
		}

		override public function clone():Event
		{
			return new SecurityErrorEvent(
					this.type,
					this.bubbles,
					this.cancelable,
					this.text,
					this.errorID
				);
		}

		override public function toString():String
		{
			return this.formatToString(
					"SecurityErrorEvent",
					"type",
					"bubbles",
					"cancelable",
					"eventPhase",
					"text"
				);
		}
	}
}
