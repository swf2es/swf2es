// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/events/ThrottleType.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.events
{
	[API("676")]
	// the docs say 674, that's wrong
	[API("676")]
	public final class ThrottleType
	{
		public static const PAUSE:String = "pause";
		public static const RESUME:String = "resume";
		public static const THROTTLE:String = "throttle";
	}
}
