// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/GraphicsStroke.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	[API("662")]
	public final class GraphicsStroke implements IGraphicsStroke, IGraphicsData
	{
		private var _caps:String;

		public var fill:IGraphicsFill;

		private var _joints:String;

		public var miterLimit:Number;

		public var pixelHinting:Boolean;

		private var _scaleMode:String;

		public var thickness:Number;

		public function GraphicsStroke(
				thickness:Number = NaN,
				pixelHinting:Boolean = false,
				scaleMode:String = "normal",
				caps:String = "none",
				joints:String = "round",
				miterLimit:Number = 3.0,
				fill:IGraphicsFill = null
			)
		{
			this.thickness = thickness;
			this.pixelHinting = pixelHinting;
			this.scaleMode = scaleMode;
			this.caps = caps;
			this.joints = joints;
			this.miterLimit = miterLimit;
			this.fill = fill;
		}

		public function get caps():String
		{
			return this._caps;
		}
		public function set caps(value:String):void
		{
			if (value != "none" && value != "square" && value != "round")
			{
				throw new ArgumentError("Error #2008: Parameter caps must be one of the accepted values.", 2008);
			}
			else
			{
				this._caps = value;
			}
		}

		public function get joints():String
		{
			return this._joints;
		}
		public function set joints(value:String)
		{
			if (value != "miter" && value != "bevel" && value != "round")
			{
				throw new ArgumentError("Error #2008: Parameter joints must be one of the accepted values.", 2008);
			}
			else
			{
				this._joints = value;
			}
		}

		public function get scaleMode():String
		{
			return this._scaleMode;
		}
		public function set scaleMode(value:String):void
		{
			if (value != "none" && value != "horizontal" && value != "vertical" && value != "normal")
			{
				throw new ArgumentError("Error #2008: Parameter scaleMode must be one of the accepted values.", 2008);
			}
			else
			{
				this._scaleMode = value;
			}
		}
	}
}
