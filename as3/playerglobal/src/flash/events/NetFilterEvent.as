// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/NetFilterEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	import flash.utils.ByteArray;

	public class NetFilterEvent extends Event
	{
		public var header:ByteArray;
		public var data:ByteArray;

		public function NetFilterEvent(
				type:String,
				bubbles:Boolean = false,
				cancelable:Boolean = false,
				header:ByteArray = null,
				data:ByteArray = null
			)
		{
			super(type, bubbles, cancelable);
			this.header = header;
			this.data = data;
		}

		override public function clone():Event
		{
			return new NetFilterEvent(
					this.type,
					this.bubbles,
					this.cancelable,
					this.header,
					this.data
				);
		}

		override public function toString():String
		{
			return this.formatToString(
					"NetTransformEvent",
					"type",
					"bubbles",
					"cancelable",
					"eventPhase",
					"header",
					"data"
				);
		}
	}
}
