// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/GraphicsSolidFill.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	[API("662")]
	public final class GraphicsSolidFill implements IGraphicsFill, IGraphicsData
	{
		public var alpha:Number = 1.0;

		public var color:uint = 0;

		public function GraphicsSolidFill(color:uint = 0, alpha:Number = 1.0)
		{
			this.alpha = alpha;
			this.color = color;
		}
	}
}
