// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/ProgressEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	public class ProgressEvent extends Event
	{
		public static const PROGRESS:String = "progress";
		public static const SOCKET_DATA:String = "socketData";

		private var _bytesLoaded:Number;
		private var _bytesTotal:Number;

		public function ProgressEvent(
				type:String,
				bubbles:Boolean = false,
				cancelable:Boolean = false,
				bytesLoaded:Number = 0,
				bytesTotal:Number = 0
			)
		{
			super(type, bubbles, cancelable);
			this._bytesLoaded = bytesLoaded;
			this._bytesTotal = bytesTotal;
		}

		public function get bytesLoaded():Number
		{
			return this._bytesLoaded;
		}
		public function set bytesLoaded(value:Number):void
		{
			this._bytesLoaded = value;
		}

		public function get bytesTotal():Number
		{
			return this._bytesTotal;
		}
		public function set bytesTotal(value:Number):void
		{
			this._bytesTotal = value;
		}

		override public function clone():Event
		{
			return new ProgressEvent(
					this.type,
					this.bubbles,
					this.cancelable,
					this.bytesLoaded,
					this.bytesTotal
				);
		}

		override public function toString():String
		{
			return this.formatToString(
					"ProgressEvent",
					"type",
					"bubbles",
					"cancelable",
					"eventPhase",
					"bytesLoaded",
					"bytesTotal"
				);
		}

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		[API("668")]
		public static const STANDARD_OUTPUT_DATA:String = "standardOutputData";
		[API("668")]
		public static const STANDARD_ERROR_DATA:String = "standardErrorData";
		[API("668")]
		public static const STANDARD_INPUT_PROGRESS:String = "standardInputProgress";
	}
}
