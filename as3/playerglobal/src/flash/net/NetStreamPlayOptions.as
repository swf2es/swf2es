// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/net/NetStreamPlayOptions.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.net
{
	import flash.events.EventDispatcher;

	[API("662")]
	public dynamic class NetStreamPlayOptions extends EventDispatcher
	{
		public var len:Number;
		[API("667")]
		public var offset:Number;
		public var oldStreamName:String;
		public var start:Number;
		public var streamName:String;
		public var transition:String;

		public function NetStreamPlayOptions()
		{
			this.len = -1;
			this.offset = -1;
			this.start = -2;
		}
	}
}
