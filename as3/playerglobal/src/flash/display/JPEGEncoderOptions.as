// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/JPEGEncoderOptions.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	[API("680")]
	public final class JPEGEncoderOptions
	{
		public var quality:uint;

		public function JPEGEncoderOptions(quality:uint = 80)
		{
			this.quality = quality;
		}
	}
}
