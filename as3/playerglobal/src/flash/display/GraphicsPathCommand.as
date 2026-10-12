// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/GraphicsPathCommand.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	[API("662")]
	public final class GraphicsPathCommand
	{
		public static const NO_OP:int = 0;
		public static const MOVE_TO:int = 1;
		public static const LINE_TO:int = 2;
		public static const CURVE_TO:int = 3;
		public static const WIDE_MOVE_TO:int = 4;
		public static const WIDE_LINE_TO:int = 5;
		public static const CUBIC_CURVE_TO:int = 6;
	}
}
