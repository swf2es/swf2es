package
{
	import flash.display.BitmapData;
	import flash.display.Graphics;
	import flash.display.Shape;
	import flash.display.Sprite;
	import flash.geom.Matrix;
	import flash.geom.Rectangle;
	import flash.utils.getQualifiedClassName;

	// Bitmap lines (cases.ts, line-bitmaps): lineBitmapStyle fills a line
	// with its bitmap, mapped in the drawing's space as a fill's is, repeated
	// or clamped, smoothed or not, and the BitmapData's later changes shown.
	public class LineBitmaps extends Sprite
	{
		public function LineBitmaps()
		{
			var checks:BitmapData = new BitmapData(8, 8, false, 0xFFFFFF);
			checks.fillRect(new Rectangle(0, 0, 4, 4), 0xE03030);
			checks.fillRect(new Rectangle(4, 0, 4, 4), 0x3030E0);
			checks.fillRect(new Rectangle(0, 4, 4, 4), 0x30A030);
			var see:BitmapData = new BitmapData(6, 6, true, 0x00000000);
			see.fillRect(new Rectangle(0, 0, 3, 6), 0x80FF8000);
			see.fillRect(new Rectangle(3, 0, 3, 6), 0xFF0060C0);

			frame(10, 10, function(g:Graphics):void
				{
					g.lineStyle(12, 0);
					g.lineBitmapStyle(checks);
					g.drawRect(6, 6, 60, 40);
				});
			frame(100, 10, function(g:Graphics):void
				{
					var m:Matrix = new Matrix();
					m.scale(3, 3);
					m.rotate(Math.PI / 6);
					m.translate(20, 4);
					g.lineStyle(12, 0);
					g.lineBitmapStyle(checks, m, false, true);
					g.drawRoundRect(6, 6, 60, 40, 20, 20);
				});
			frame(190, 10, function(g:Graphics):void
				{
					g.lineStyle(10, 0, 1, false, "normal", "none", "bevel");
					g.lineBitmapStyle(see, new Matrix(2, 0, 0, 2, 0, 0));
					g.moveTo(6, 40);
					g.lineTo(26, 6);
					g.lineTo(46, 40);
					g.lineTo(66, 6);
				});
			var scaled:Shape = frame(280, 10, function(g:Graphics):void
				{
					g.lineStyle(0, 0);
					g.lineBitmapStyle(checks);
					g.drawCircle(15, 15, 12);
					g.moveTo(0, 0);
					g.lineTo(30, 30);
				});
			scaled.scaleX = scaled.scaleY = 2;

			// Drawn, then the bitmap changed: the line shows what it has when drawn.
			var later:BitmapData = checks.clone();
			frame(10, 110, function(g:Graphics):void
				{
					g.lineStyle(14, 0);
					g.lineBitmapStyle(later);
					g.moveTo(10, 10);
					g.lineTo(150, 10);
				});
			later.fillRect(new Rectangle(0, 0, 8, 2), 0x000000);

			// The colour before it, the line after it, a bitmap before any line.
			frame(190, 110, function(g:Graphics):void
				{
					g.lineStyle(8, 0x00A000, 0.3);
					g.moveTo(0, 10);
					g.lineTo(30, 10);
					g.lineBitmapStyle(checks);
					g.lineTo(60, 30);
					g.lineStyle(8, 0xFF8000);
					g.lineTo(90, 10);
					g.lineStyle();
					g.lineBitmapStyle(checks);
					g.lineTo(120, 30);
				});

			// A bitmap set mid-path, after a solid line of whole alpha, of part alpha, and after a gradient.
			var strip:Matrix = new Matrix();
			strip.createGradientBox(30, 20, 0, 0, 0);
			for each (var alpha:Number in [1, 0.3])
			{
				frame(alpha == 1 ? 10 : 100, 150, function(g:Graphics):void
					{
						g.lineStyle(8, 0x00A000, alpha);
						g.moveTo(0, 10);
						g.lineTo(30, 10);
						g.lineBitmapStyle(checks);
						g.lineTo(60, 30);
					});
			}

			frame(190, 150, function(g:Graphics):void
				{
					g.lineStyle(8, 0x00A000, 0.3);
					g.moveTo(0, 10);
					g.lineTo(30, 10);
					g.lineGradientStyle("linear", [0xFF0000, 0x0000FF], [1, 1], [0, 255], strip);
					g.lineTo(60, 30);
					g.lineBitmapStyle(checks);
					g.lineTo(90, 10);
				});
			frame(300, 150, function(g:Graphics):void
				{
					g.lineStyle(8, 0x00A000, 0.3);
					g.lineBitmapStyle(checks);
					g.moveTo(0, 10);
					g.lineTo(30, 10);
					g.lineBitmapStyle(checks, new Matrix(3, 0, 0, 3));
					g.lineTo(60, 30);
				});

			for each (var odd:Array in [[true, null], [false, null], [false, checks]])
			{
				try
				{
					var s:Shape = new Shape();
					if (odd[0])
					{
						s.graphics.lineStyle(1);
					}

					s.graphics.lineBitmapStyle(odd[1]);
					trace(odd[0], odd[1], "ok");
				}
				catch (e:Error)
				{
					trace(odd[0], odd[1], getQualifiedClassName(e), e.errorID);
				}
			}

			var gone:BitmapData = new BitmapData(2, 2);
			gone.dispose();
			try
			{
				var d:Shape = new Shape();
				d.graphics.lineStyle(1);
				d.graphics.lineBitmapStyle(gone);
				trace("disposed ok");
			}
			catch (e:Error)
			{
				trace("disposed", getQualifiedClassName(e), e.errorID);
			}
		}

		private function frame(x:Number, y:Number, draw:Function):Shape
		{
			var shape:Shape = new Shape();
			draw(shape.graphics);
			shape.x = x;
			shape.y = y;
			addChild(shape);
			return shape;
		}
	}
}
