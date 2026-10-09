// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/GraphicsShaderFill.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	import flash.geom.Matrix;

	[API("662")]
	public final class GraphicsShaderFill implements IGraphicsFill, IGraphicsData
	{
		public var shader:Shader;

		public var matrix:Matrix;

		public function GraphicsShaderFill(shader:Shader = null, matrix:Matrix = null)
		{
			this.shader = shader;
			this.matrix = matrix;
		}
	}
}
