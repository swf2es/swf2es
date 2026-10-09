// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/Graphics.ts.

package flash.display
{
	import flash.geom.Matrix;

	public final class Graphics
	{
		public function Graphics()
		{
		}

		public native function clear():void;

		public native function beginFill(color:uint, alpha:Number = 1):void;

		public native function beginGradientFill(type:String, colors:Array, alphas:Array, ratios:Array, matrix:Matrix = null, spreadMethod:String = "pad", interpolationMethod:String = "rgb", focalPointRatio:Number = 0):void;

		public native function beginBitmapFill(bitmap:BitmapData, matrix:Matrix = null, repeat:Boolean = true, smooth:Boolean = false):void;

		[API("662")]
		public native function beginShaderFill(shader:Shader, matrix:Matrix = null):void;

		public native function lineGradientStyle(type:String, colors:Array, alphas:Array, ratios:Array, matrix:Matrix = null, spreadMethod:String = "pad", interpolationMethod:String = "rgb", focalPointRatio:Number = 0):void;

		public native function lineStyle(thickness:Number = void 0, color:uint = 0, alpha:Number = 1, pixelHinting:Boolean = false, scaleMode:String = "normal", caps:String = null, joints:String = null, miterLimit:Number = 3):void;

		public native function drawRect(x:Number, y:Number, width:Number, height:Number):void;

		public native function drawRoundRect(x:Number, y:Number, width:Number, height:Number, ellipseWidth:Number, ellipseHeight:Number = void 0):void;

		public native function drawRoundRectComplex(x:Number, y:Number, width:Number, height:Number, topLeftRadius:Number, topRightRadius:Number, bottomLeftRadius:Number, bottomRightRadius:Number):void;

		public function drawCircle(x:Number, y:Number, radius:Number):void
		{
			drawEllipse(x - radius, y - radius, radius * 2, radius * 2);
		}

		public function drawEllipse(x:Number, y:Number, width:Number, height:Number):void
		{
			// An ellipse is a rectangle rounded all the way.
			drawRoundRect(x, y, width, height, width, height);
		}

		public native function moveTo(x:Number, y:Number):void;

		public native function lineTo(x:Number, y:Number):void;

		public native function curveTo(controlX:Number, controlY:Number, anchorX:Number, anchorY:Number):void;

		[API("674")]
		public native function cubicCurveTo(controlX1:Number, controlY1:Number, controlX2:Number, controlY2:Number, anchorX:Number, anchorY:Number):void;

		public native function endFill():void;

		[API("662")]
		public native function copyFrom(sourceGraphics:Graphics):void;

		[API("662")]
		public native function lineBitmapStyle(bitmap:BitmapData, matrix:Matrix = null, repeat:Boolean = true, smooth:Boolean = false):void;

		[API("662")]
		public native function lineShaderStyle(shader:Shader, matrix:Matrix = null):void;

		[API("662")]
		public native function drawPath(commands:Vector.<int>, data:Vector.<Number>, winding:String = "evenOdd"):void;

		[API("662")]
		public native function drawTriangles(vertices:Vector.<Number>, indices:Vector.<int> = null, uvtData:Vector.<Number> = null, culling:String = "none"):void;

		[API("662")]
		public function drawGraphicsData(graphicsData:Vector.<IGraphicsData>):void
		{
			for (var i:int = 0; i < graphicsData.length; i++)
			{
				drawDatum(graphicsData[i]);
			}
		}

		// Each kind of graphics data as the drawing call it stands for.
		private function drawDatum(datum:IGraphicsData):void
		{
			if (datum is GraphicsSolidFill)
			{
				const solid:GraphicsSolidFill = GraphicsSolidFill(datum);
				beginFill(solid.color, solid.alpha);
			}
			else if (datum is GraphicsGradientFill)
			{
				const gradient:GraphicsGradientFill = GraphicsGradientFill(datum);
				beginGradientFill(gradient.type, gradient.colors, gradient.alphas, gradient.ratios, gradient.matrix, gradient.spreadMethod, gradient.interpolationMethod, gradient.focalPointRatio);
			}
			else if (datum is GraphicsBitmapFill)
			{
				const bitmap:GraphicsBitmapFill = GraphicsBitmapFill(datum);
				beginBitmapFill(bitmap.bitmapData, bitmap.matrix, bitmap.repeat, bitmap.smooth);
			}
			else if (datum is GraphicsShaderFill)
			{
				const shader:GraphicsShaderFill = GraphicsShaderFill(datum);
				beginShaderFill(shader.shader, shader.matrix);
			}
			else if (datum is GraphicsEndFill)
			{
				endFill();
			}
			else if (datum is GraphicsStroke)
			{
				stroke(GraphicsStroke(datum));
			}
			else if (datum is GraphicsPath)
			{
				const path:GraphicsPath = GraphicsPath(datum);
				if (path.commands != null && path.data != null)
				{
					drawPath(path.commands, path.data, path.winding);
				}
			}
			else if (datum is GraphicsTrianglePath)
			{
				const triangles:GraphicsTrianglePath = GraphicsTrianglePath(datum);
				if (triangles.vertices != null)
				{
					drawTriangles(triangles.vertices, triangles.indices, triangles.uvtData, triangles.culling);
				}
			}
		}

		// A stroke's line, its fill as the line's own; NaN thickness, no line.
		private function stroke(stroke:GraphicsStroke):void
		{
			if (isNaN(stroke.thickness))
			{
				lineStyle();
				return;
			}

			const solid:GraphicsSolidFill = stroke.fill as GraphicsSolidFill;
			lineStyle(stroke.thickness, solid != null ? solid.color : 0, solid != null ? solid.alpha : 1, stroke.pixelHinting, stroke.scaleMode, stroke.caps, stroke.joints, stroke.miterLimit);
			if (stroke.fill is GraphicsGradientFill)
			{
				const gradient:GraphicsGradientFill = GraphicsGradientFill(stroke.fill);
				lineGradientStyle(gradient.type, gradient.colors, gradient.alphas, gradient.ratios, gradient.matrix, gradient.spreadMethod, gradient.interpolationMethod, gradient.focalPointRatio);
			}
			else if (stroke.fill is GraphicsBitmapFill)
			{
				const bitmap:GraphicsBitmapFill = GraphicsBitmapFill(stroke.fill);
				lineBitmapStyle(bitmap.bitmapData, bitmap.matrix, bitmap.repeat, bitmap.smooth);
			}
			else if (stroke.fill is GraphicsShaderFill)
			{
				const shader:GraphicsShaderFill = GraphicsShaderFill(stroke.fill);
				lineShaderStyle(shader.shader, shader.matrix);
			}
		}

		[API("686")]
		public function readGraphicsData(recurse:Boolean = true):Vector.<IGraphicsData>
		{
			const result:Vector.<IGraphicsData> = new Vector.<IGraphicsData>();
			nativeGetGraphicsData(result, recurse);
			return result;
		}

		// The player's natives (packages/player/src/playerglobal/flash/display/Graphics.ts).
		private native function nativeGetGraphicsData(target:Vector.<IGraphicsData>, recurse:Boolean):void;
	}
}
