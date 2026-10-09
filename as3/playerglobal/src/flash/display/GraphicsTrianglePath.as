// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/GraphicsTrianglePath.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	[API("662")]
	public final class GraphicsTrianglePath implements IGraphicsPath, IGraphicsData
	{
		private var _culling:String;

		public var indices:Vector.<int>;

		public var uvtData:Vector.<Number>;

		public var vertices:Vector.<Number>;

		public function GraphicsTrianglePath(
				vertices:Vector.<Number> = null,
				indices:Vector.<int> = null,
				uvtData:Vector.<Number> = null,
				culling:String = "none"
			)
		{
			this.culling = culling;
			this.indices = indices;
			this.uvtData = uvtData;
			this.vertices = vertices;
		}

		public function get culling():String
		{
			return this._culling;
		}
		public function set culling(value:String):void
		{
			// TODO do validation
			this._culling = value;
		}
	}
}
