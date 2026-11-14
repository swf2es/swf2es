package
{
	import flash.display.GradientType;
	import flash.display.Graphics;
	import flash.display.Shape;
	import flash.display.Sprite;
	import flash.geom.Matrix;
	import flash.utils.getQualifiedClassName;

	// Gradient lines (cases.ts, line-gradients): lineGradientStyle fills a
	// line with its gradient, mapped in the drawing's space as a fill's is,
	// and what it makes of odd arguments and of no line before it.
	public class LineGradients extends Sprite
	{
		public function LineGradients()
		{
			// A frame faint at the top and bright at the bottom, over a fill of its own gradient, drawn
			// as is, scaled and turned. The first on pixels' centres, where Flash snaps a line a pixel
			// wide on pixels' edges to whole pixels and the player does not.
			box(10.5, 10.5, 1, 0);
			box(80, 10, 2, 0);
			box(260, 10, 1, Math.PI / 6);

			// A thick zigzag, mitred, red to blue across it, and one of alpha stops over a bar.
			var bar:Shape = new Shape();
			bar.graphics.beginFill(0x30A030);
			bar.graphics.drawRect(10, 160, 160, 10);
			addChild(bar);
			var across:Matrix = new Matrix();
			across.createGradientBox(160, 40, 0, 10, 130);
			zigzag(130, across, [0xFF0000, 0x0000FF], [1, 1], 8, "miter");
			zigzag(165, across, [0x000000, 0x000000], [0, 1], 10, "round");

			// A ring of a radial gradient, its focus off centre, reflected.
			var ring:Shape = new Shape();
			var around:Matrix = new Matrix();
			around.createGradientBox(60, 60, 0, 190, 130);
			ring.graphics.lineStyle(12, 0);
			ring.graphics.lineGradientStyle(GradientType.RADIAL, [0xFFFF00, 0xFF00FF, 0x00FFFF], [1, 1, 1],
					[0, 128, 255], around, "reflect", "rgb", 0.5);
			ring.graphics.drawCircle(220, 160, 24);
			addChild(ring);

			// Hairlines of a gradient, as drawn and in a shape scaled four times, on pixels' centres.
			var hair:Shape = new Shape();
			var down:Matrix = new Matrix();
			down.createGradientBox(100, 40, 0, 270, 130);
			hair.graphics.lineStyle(0, 0);
			hair.graphics.lineGradientStyle(GradientType.LINEAR, [0xFF0000, 0x00A000], [1, 1], [0, 255], down);
			for (var i:int = 0; i < 5; i++)
			{
				hair.graphics.moveTo(270 + i * 6, 130);
				hair.graphics.lineTo(300 + i * 14, 170);
			}

			addChild(hair);
			var big:Shape = new Shape();
			var small:Matrix = new Matrix();
			small.createGradientBox(20, 10, 0, 0, 0);
			big.graphics.lineStyle(0, 0);
			big.graphics.lineGradientStyle(GradientType.LINEAR, [0x0000FF, 0xFF8000], [1, 1], [0, 255], small);
			big.graphics.drawRect(0, 0, 18, 10);
			big.x = 300.5;
			big.y = 180.5;
			big.scaleX = big.scaleY = 4;
			addChild(big);

			// The line's own alpha, a gradient set mid-path, a line set after one, a gradient with no line
			// before it, and arrays that do not match.
			var row:Number = 240;
			var strip:Matrix = new Matrix();
			strip.createGradientBox(40, 20, 0, 0, 0);
			sample(10, row, function(g:Graphics):void
				{
					g.lineStyle(6, 0x000000, 0.25);
					g.lineGradientStyle(GradientType.LINEAR, [0xFF0000, 0x0000FF], [1, 1], [0, 255], strip);
					g.moveTo(0, 10);
					g.lineTo(40, 10);
				});
			sample(60, row, function(g:Graphics):void
				{
					g.lineStyle(6, 0x00A000);
					g.moveTo(0, 10);
					g.lineTo(20, 0);
					g.lineGradientStyle(GradientType.LINEAR, [0xFF0000, 0x0000FF], [1, 1], [0, 255], strip);
					g.lineTo(40, 10);
				});
			sample(110, row, function(g:Graphics):void
				{
					g.lineStyle(6, 0x00A000);
					g.lineGradientStyle(GradientType.LINEAR, [0xFF0000, 0x0000FF], [1, 1], [0, 255], strip);
					g.moveTo(0, 10);
					g.lineTo(20, 0);
					g.lineStyle(6, 0xFF8000);
					g.lineTo(40, 10);
				});
			sample(160, row, function(g:Graphics):void
				{
					g.lineGradientStyle(GradientType.LINEAR, [0xFF0000, 0x0000FF], [1, 1], [0, 255], strip);
					g.moveTo(0, 10);
					g.lineTo(40, 10);
					g.lineStyle();
					g.lineGradientStyle(GradientType.LINEAR, [0xFF0000, 0x0000FF], [1, 1], [0, 255], strip);
					g.lineTo(40, 20);
				});
			sample(210, row, function(g:Graphics):void
				{
					g.lineStyle(6, 0x00A000);
					g.lineGradientStyle(GradientType.LINEAR, [0xFF0000, 0x0000FF], [1], [0, 255], strip);
					g.moveTo(0, 10);
					g.lineTo(40, 10);
				});
			sample(260, row, function(g:Graphics):void
				{
					g.lineStyle(6, 0x00A000);
					g.lineGradientStyle(GradientType.LINEAR, [0xFF0000, 0x0000FF], null, null);
					g.moveTo(0, 10);
					g.lineTo(40, 10);
				});
			sample(310, row, function(g:Graphics):void
				{
					g.beginFill(0xC0C0C0);
					g.lineStyle(4, 0x00A000);
					g.lineGradientStyle(GradientType.LINEAR, [0xFF0000, 0x0000FF], [1, 1], [0, 255], strip);
					g.drawRect(0, 0, 40, 20);
					g.endFill();
				});

			for each (var odd:Array in [["conic", [0], [1], [0]], ["linear", null, [1], [0]], ["radial", [0], null, null]])
			{
				try
				{
					var s:Shape = new Shape();
					s.graphics.lineStyle(1);
					s.graphics.lineGradientStyle(odd[0], odd[1], odd[2], odd[3]);
					trace(odd[0], "ok");
				}
				catch (e:Error)
				{
					trace(odd[0], getQualifiedClassName(e), e.errorID);
				}
			}

			// Which argument is checked first, and whether with no line.
			for each (var order:Array in [[true, "conic", null], [false, "conic", null], [false, "conic", [0]],
					[false, "linear", null], [false, "linear", [0, 0]]])
			{
				try
				{
					var o:Shape = new Shape();
					if (order[0])
					{
						o.graphics.lineStyle(1);
					}

					o.graphics.lineGradientStyle(order[1], order[2], [1], [0]);
					trace(order.join(" "), "ok");
				}
				catch (e:Error)
				{
					trace(order.join(" "), getQualifiedClassName(e), e.errorID);
				}
			}

			var measured:Shape = new Shape();
			measured.graphics.lineStyle(10, 0);
			measured.graphics.lineGradientStyle(GradientType.LINEAR, [0xFF0000, 0x0000FF], [1, 1], [0, 255]);
			measured.graphics.moveTo(0, 0);
			measured.graphics.lineTo(100, 0);
			trace("bounds", measured.getBounds(measured));
		}

		private function box(x:Number, y:Number, scale:Number, angle:Number):void
		{
			var shape:Shape = new Shape();
			var g:Graphics = shape.graphics;
			var m:Matrix = new Matrix();
			m.createGradientBox(60, 50, Math.PI / 2, 0, 0);
			g.beginGradientFill(GradientType.LINEAR, [0xF0F0F0, 0xB0B0B0], [1, 1], [0, 255], m);
			g.drawRoundRect(0, 0, 60, 50, 12, 12);
			g.endFill();
			g.beginFill(0, 0);
			g.lineStyle(1, 0x404040);
			var edge:Matrix = new Matrix();
			edge.createGradientBox(1, 48, Math.PI / 2, 0, 1);
			g.lineGradientStyle(GradientType.LINEAR, [0x404040, 0x404040], [0.2, 1], [0, 255], edge);
			g.drawRoundRect(0, 0, 60, 50, 12, 12);
			g.endFill();
			shape.x = x;
			shape.y = y;
			shape.scaleX = shape.scaleY = scale;
			shape.rotation = angle * 180 / Math.PI;
			addChild(shape);
		}

		private function zigzag(y:Number, m:Matrix, colors:Array, alphas:Array, width:Number, joints:String):void
		{
			var shape:Shape = new Shape();
			var g:Graphics = shape.graphics;
			g.lineStyle(width, 0x808080, 1, false, "normal", null, joints);
			g.lineGradientStyle(GradientType.LINEAR, colors, alphas, [0, 255], m);
			g.moveTo(15, y);
			for (var i:int = 1; i <= 6; i++)
			{
				g.lineTo(15 + i * 25, y + (i % 2 ? 20 : 0));
			}

			addChild(shape);
		}

		private function sample(x:Number, y:Number, draw:Function):void
		{
			var shape:Shape = new Shape();
			draw(shape.graphics);
			shape.x = x;
			shape.y = y;
			addChild(shape);
		}
	}
}
