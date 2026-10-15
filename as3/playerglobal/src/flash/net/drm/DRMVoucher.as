// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/net/drm/DRMVoucher.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.net.drm
{
	[API("663", "667")]
	public class DRMVoucher
	{

		// Flash Player's API that Ruffle's source lacks: native, and not implemented.
		public native function get voucherStartDate():Date;
		public native function get voucherEndDate():Date;
		public native function get offlineLeaseStartDate():Date;
		public native function get offlineLeaseEndDate():Date;
		public native function get policies():Object;
		public native function get playbackTimeWindow():DRMPlaybackTimeWindow;
	}
}
