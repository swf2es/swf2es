// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/system/MessageChannelState.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.system
{
	[API("682")]
	public final class MessageChannelState
	{
		public static const CLOSED:String = "closed";
		public static const CLOSING:String = "closing";
		public static const OPEN:String = "open";
	}
}
