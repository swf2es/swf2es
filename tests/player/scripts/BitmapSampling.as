// How Flash samples a Bitmap that it scales or turns (cases.ts,
// bitmap-sampling): one 16 by 16 pattern, checks, a ramp and single-pixel
// lines, enlarged and shrunk, rotated, flipped, a hair off its size, with
// and without smoothing; and a shape's bitmap fill moved by half a pixel.
// Flash reads such a bitmap once a pixel, at its centre, the texel it falls
// in or, smoothed, the four around; its unsmoothed edges are aliased.
package
{
	import flash.display.Bitmap;
	import flash.display.BitmapData;
	import flash.display.Sprite;

	public class BitmapSampling extends Sprite
	{
		public function BitmapSampling()
		{
			graphics.beginFill(0x808080);
			graphics.drawRect(0, 0, 480, 250);
			graphics.endFill();

			const data:BitmapData = pattern();
			for (var row:int = 0; row < 2; row++)
			{
				const smooth:Boolean = row == 1;
				const y:Number = 4 + row * 100;
				place(data, smooth, 44, y, 3, 0);
				place(data, smooth, 96, y, 2.37, 0);
				place(data, smooth, 140, y, 0.6, 0);
				place(data, smooth, 160, y, 0.43, 0);
				place(data, smooth, 196, y + 4, 2, 30);
				place(data, smooth, 270, y + 2, 3, -17);
				place(data, smooth, 360, y + 40, 1, 45);
				place(data, smooth, 400, y + 30, 2.5, 90);
				place(data, smooth, 420, y + 60, 1.5, 180);
			}

			// At its size, but flipped, a quarter turn, a half turn, a hair larger and smaller.
			const flipped:Bitmap = new Bitmap(data, "auto", true);
			flipped.x = 20.5;
			flipped.y = 204.5;
			flipped.scaleX = -1;
			addChild(flipped);
			place(data, true, 40.5, 204.5, 1, 90);
			place(data, true, 60.5, 220.5, 1, 180);
			place(data, true, 70.5, 204.5, 1.01, 0);
			place(data, true, 90.5, 204.5, 0.99, 0);
			const fill:Sprite = new Sprite();
			fill.graphics.beginBitmapFill(data, null, false, true);
			fill.graphics.drawRect(0, 0, 16, 16);
			fill.graphics.endFill();
			fill.x = 130.5;
			fill.y = 204.5;
			addChild(fill);
			const fillHard:Sprite = new Sprite();
			fillHard.graphics.beginBitmapFill(data, null, false, false);
			fillHard.graphics.drawRect(0, 0, 16, 16);
			fillHard.graphics.endFill();
			fillHard.x = 150.5;
			fillHard.y = 204.5;
			addChild(fillHard);
			trace("drawn");
		}

		private function place(data:BitmapData, smooth:Boolean, x:Number, y:Number, scale:Number, rotation:Number):void
		{
			const bitmap:Bitmap = new Bitmap(data, "auto", smooth);
			bitmap.x = x;
			bitmap.y = y;
			bitmap.scaleX = bitmap.scaleY = scale;
			bitmap.rotation = rotation;
			addChild(bitmap);
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
