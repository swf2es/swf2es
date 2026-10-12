// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/GraphicsBitmapFill.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	import flash.geom.Matrix;

	[API("662")]
	public final class GraphicsBitmapFill implements IGraphicsFill, IGraphicsData
	{
		public var bitmapData:BitmapData;

		public var matrix:Matrix;

		public var repeat:Boolean;

		public var smooth:Boolean;

		public function GraphicsBitmapFill(
				bitmapData:BitmapData = null,
				matrix:Matrix = null,
				repeat:Boolean = true,
				smooth:Boolean = false
			)
		{
			this.bitmapData = bitmapData;
			this.matrix = matrix;
			this.repeat = repeat;
			this.smooth = smooth;
		}
	}
}
