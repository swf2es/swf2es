// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/display/GraphicsGradientFill.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.display
{
	import flash.geom.Matrix;

	[API("662")]
	public final class GraphicsGradientFill implements IGraphicsFill, IGraphicsData
	{
		public var alphas:Array;

		public var colors:Array;

		public var focalPointRatio:Number;

		public var matrix:Matrix;

		public var ratios:Array;

		private var _interpolationMethod:String;

		private var _spreadMethod:String;

		private var _type:String;

		public function GraphicsGradientFill(
				type:String = "linear",
				colors:Array = null,
				alphas:Array = null,
				ratios:Array = null,
				matrix:* = null,
				spreadMethod:* = SpreadMethod.PAD,
				interpolationMethod:String = InterpolationMethod.RGB,
				focalPointRatio:Number = 0.0
			)
		{
			this.alphas = alphas;
			this.colors = colors;
			this.focalPointRatio = focalPointRatio;
			this.matrix = matrix;
			this.ratios = ratios;

			this.interpolationMethod = interpolationMethod;
			this.spreadMethod = spreadMethod;
			this.type = type;
		}

		public function get type():String
		{
			return this._type;
		}
		public function set type(value:String):*
		{
			// TODO do validation
			this._type = value;
		}

		public function get spreadMethod():String
		{
			return this._spreadMethod;
		}
		public function set spreadMethod(value:String):*
		{
			// TODO do validation
			this._spreadMethod = value;
		}

		public function get interpolationMethod():String
		{
			return this._interpolationMethod;
		}
		public function set interpolationMethod(value:String):*
		{
			// TODO do validation
			this._interpolationMethod = value;
		}
	}
}
