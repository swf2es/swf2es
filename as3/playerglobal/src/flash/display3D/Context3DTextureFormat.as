// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display3D/Context3DTextureFormat.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display3D
{
	[API("674")]
	public final class Context3DTextureFormat
	{
		public static const BGRA:String = "bgra";

		[API("688")]
		public static const BGRA_PACKED:String = "bgraPacked4444";

		[API("688")]
		public static const BGR_PACKED:String = "bgrPacked565";

		public static const COMPRESSED:String = "compressed";

		[API("682")]
		public static const COMPRESSED_ALPHA:String = "compressedAlpha";

		[API("698")]
		public static const RGBA_HALF_FLOAT:String = "rgbaHalfFloat";
	}
}
