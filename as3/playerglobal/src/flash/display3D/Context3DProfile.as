// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display3D/Context3DProfile.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display3D
{
	[API("682")]
	public final class Context3DProfile
	{
		public static const BASELINE:String = "baseline";

		public static const BASELINE_CONSTRAINED:String = "baselineConstrained";

		[API("690")]
		public static const BASELINE_EXTENDED:String = "baselineExtended";

		[API("698")]
		public static const STANDARD:String = "standard";

		[API("702")]
		public static const STANDARD_CONSTRAINED:String = "standardConstrained";

		[API("704")]
		// the docs say 706, that's wrong
		public static const STANDARD_EXTENDED:String = "standardExtended";
	}
}
