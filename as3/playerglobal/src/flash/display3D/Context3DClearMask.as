// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display3D/Context3DClearMask.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display3D
{
	public final class Context3DClearMask
	{
		public static const ALL:int = COLOR | DEPTH | STENCIL;
		public static const COLOR:int = 1 << 0;
		public static const DEPTH:int = 1 << 1;
		public static const STENCIL:int = 1 << 2;
	}
}
