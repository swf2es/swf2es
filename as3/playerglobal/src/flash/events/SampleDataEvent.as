// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/SampleDataEvent.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	import flash.utils.ByteArray;

	[API("662")]
	public class SampleDataEvent extends Event
	{
		public static const SAMPLE_DATA:String = "sampleData";

		private var _position:Number;
		private var _data:ByteArray;

		public function SampleDataEvent(
				type:String,
				bubbles:Boolean = false,
				cancelable:Boolean = false,
				theposition:Number = 0,
				thedata:ByteArray = null
			)
		{
			super(type, bubbles, cancelable);
			this.position = theposition;
			this.data = thedata;
		}

		public function get position():Number
		{
			return this._position;
		}
		public function set position(value:Number)
		{
			this._position = value;
		}

		public function get data():ByteArray
		{
			return this._data;
		}
		public function set data(value:ByteArray)
		{
			this._data = value;
		}

		override public function clone():Event
		{
			return new SampleDataEvent(
					this.type,
					this.bubbles,
					this.cancelable,
					this.position,
					this.data
				);
		}

		override public function toString():String
		{
			return this.formatToString(
					"SampleDataEvent",
					"type",
					"bubbles",
					"cancelable",
					"eventPhase",
					"position",
					"data"
				);
		}
	}
}
