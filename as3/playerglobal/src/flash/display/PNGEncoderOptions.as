// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/PNGEncoderOptions.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	[API("680")]
	public final class PNGEncoderOptions
	{
		public var fastCompression:Boolean;

		public function PNGEncoderOptions(fastCompression:Boolean = false)
		{
			this.fastCompression = fastCompression;
		}
	}
}
