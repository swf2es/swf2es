// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/net/drm/DRMPlaybackTimeWindow.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.net.drm
{
	public class DRMPlaybackTimeWindow
	{

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		public native function get period():uint;
		public native function get startDate():Date;
		public native function get endDate():Date;
	}
}
