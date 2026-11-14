// Where Flash draws a Bitmap it only moves (cases.ts, bitmap-placement): one
// 16 by 16 pattern, smoothed and not, at whole pixels, by fractions of one
// from 0.05 to 0.95, and inside a parent moved by a fraction. Flash draws it
// texel for pixel, unsmoothed even when smoothed, on the pixel its twips
// round to, a fraction of 8 twips or more up; and keeps x and y in whole
// twips, truncated toward zero.
package
{
	import flash.display.Bitmap;
	import flash.display.BitmapData;
	import flash.display.Sprite;

	public class BitmapPlacement extends Sprite
	{
		public function BitmapPlacement()
		{
			graphics.beginFill(0x808080);
			graphics.drawRect(0, 0, 480, 100);
			graphics.endFill();

			const data:BitmapData = pattern();
			const offsets:Array = [0, 0.05, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3, 0.35, 0.375, 0.4, 0.45,
					0.5, 0.55, 0.6, 0.625, 0.65, 0.7, 0.75, 0.8, 0.875, 0.9];
			for (var i:int = 0; i < offsets.length; i++)
			{
				place(this, data, true, 4 + i * 21 + offsets[i], 4 + offsets[i], 1, 0);
				place(this, data, false, 4 + i * 21 + offsets[i], 24 + offsets[i], 1, 0);
			}

			const parent:Sprite = new Sprite();
			parent.x = 0.3;
			parent.y = -0.45;
			addChild(parent);
			place(parent, data, true, 4.3, 54.3, 1, 0);
			place(parent, data, false, 24.15, 54.15, 1, 0);
			// Negative fractions, from the right and the bottom.
			place(this, data, false, 44 - 0.55, 54 - 0.3, 1, 0);
			place(this, data, true, 64 - 0.35, 54 - 0.65, 1, 0);

			// Drawn into a BitmapData: moved by fractions there too, smoothed and not.
			const holder:Sprite = new Sprite();
			place(holder, data, true, 0.45, 0.45, 1, 0);
			place(holder, data, false, 20.3, 0.3, 1, 0);
			place(holder, data, true, 40.6, 0.6, 1, 0);
			const drawn:BitmapData = new BitmapData(60, 20, false, 0x808080);
			drawn.draw(holder);
			const shown:Bitmap = new Bitmap(drawn);
			shown.x = 100;
			shown.y = 54;
			addChild(shown);

			// Positions are kept in twips: what a fraction of one comes back as.
			const probe:Sprite = new Sprite();
			for each (var v:Number in [172.375, 0.375, 0.3999, 0.0249, -0.375, -172.375, -0.0249, 4.35,
						1.15, -4.35, 1e9, 107374182.4, 107374182.35, -107374182.45, Infinity, NaN])
			{
				probe.x = v;
				probe.y = -v;
				trace(v, probe.x, probe.y, probe.transform.matrix.tx);
			}
			trace("drawn");
		}

		private static function place(parent:Sprite, data:BitmapData, smooth:Boolean, x:Number, y:Number, scale:Number, rotation:Number):void
		{
			const bitmap:Bitmap = new Bitmap(data, "auto", smooth);
			bitmap.x = x;
			bitmap.y = y;
			bitmap.scaleX = bitmap.scaleY = scale;
			bitmap.rotation = rotation;
			parent.addChild(bitmap);
		}

		private static function pattern():BitmapData
		{
			const data:BitmapData = new BitmapData(16, 16, true, 0);
			for (var y:int = 0; y < 16; y++)
			{
				for (var x:int = 0; x < 16; x++)
				{
					var c:uint;
					if (y < 6)
					{
						c = (x + y) % 2 == 0 ? 0xffd02020 : 0xff2040d0;
					}
					else if (y < 10)
					{
						c = 0xff000000 | (x * 17) << 16 | (255 - x * 17) << 8 | 0x40;
					}
					else if (x == 3 || y == 12)
					{
						c = 0xffffffff;
					}
					else if (x > 10 && y > 12)
					{
						c = 0x80ffff00;
					}
					else
					{
						c = 0xff103010;
					}
					data.setPixel32(x, y, c);
				}
			}
			return data;
		}
	}
}
