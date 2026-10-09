// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/JPEGXREncoderOptions.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	[API("680")]
	public final class JPEGXREncoderOptions
	{
		public var quantization:uint;
		public var colorSpace:String;
		public var trimFlexBits:uint;

		public function JPEGXREncoderOptions(
				quantization:uint = 20,
				colorSpace:String = "auto",
				trimFlexBits:uint = 0
			)
		{
			this.quantization = quantization;
			this.colorSpace = colorSpace;
			this.trimFlexBits = trimFlexBits;
		}
	}
}
