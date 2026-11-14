package
{
	import flash.display.*;
	import flash.events.Event;
	import flash.geom.ColorTransform;
	import flash.geom.Matrix;

	// Bitmaps blended onto a gradient, each alone in its blend: in a sprite of
	// the mode, or of the mode itself, scaled; coloured by the
	// sprite and by the bitmap, their pixels opaque, part clear and clear.
	// Every mode a bitmap's quad may be drawn in straight onto what is below,
	// and subtract, which keeps its layer.
	public class BlendBitmaps extends Sprite
	{
		private static const MODES:Array = [
				"add", "screen", "multiply", "lighten", "darken", "difference",
				"overlay", "hardlight", "invert", "subtract"
			];

		private function pattern():BitmapData
		{
			var data:BitmapData = new BitmapData(24, 20, true, 0);
			for (var y:int = 0; y < 20; y++)
			{
				for (var x:int = 0; x < 24; x++)
				{
					var alpha:uint = x < 8 ? 0xff : x < 16 ? 0x80 : (y & 4) ? 0x40 : 0;
					var red:uint = (x * 10) & 0xff;
					var green:uint = (y * 12) & 0xff;
					var blue:uint = ((x + y) * 6) & 0xff;
					data.setPixel32(x, y, (alpha << 24) | (red << 16) | (green << 8) | blue);
				}
			}

			return data;
		}

		public function BlendBitmaps()
		{
			var matrix:Matrix = new Matrix();
			matrix.createGradientBox(400, 140, 0.4, 0, 0);
			graphics.beginGradientFill(GradientType.LINEAR, [0x102040, 0xe0c060, 0x40a0d0], [1, 1, 1], [0, 128, 255], matrix);
			graphics.drawRect(0, 0, 400, 140);
			graphics.endFill();

			var data:BitmapData = pattern();
			var scaled:Array = [];
			for (var i:int = 0; i < MODES.length; i++)
			{
				// In a sprite of the mode, coloured by the sprite.
				var bitmap:Bitmap = new Bitmap(data);
				var holder:Sprite = new Sprite();
				holder.addChild(bitmap);
				holder.blendMode = MODES[i];
				holder.x = 8 + i * 39;
				holder.y = 10;
				holder.transform.colorTransform = new ColorTransform(1, 0.8, 1, 1, 20, 0, -30, 0);
				addChild(holder);

				// Of the mode itself, scaled, coloured by the bitmap.
				var own:Bitmap = new Bitmap(data);
				own.blendMode = MODES[i];
				own.x = 8 + i * 39;
				own.y = 60;
				own.scaleX = 2;
				own.scaleY = 2;
				own.transform.colorTransform = new ColorTransform(0.9, 1, 1.1, 1, 0, 40, 0, 0);
				addChild(own);
				scaled.push(own);
			}

			// Moved and scaled again between frames.
			var frame:int = 0;
			addEventListener(Event.ENTER_FRAME, function(event:Event):void
				{
					frame++;
					if (frame == 2)
					{
						for (var j:int = 0; j < scaled.length; j++)
						{
							scaled[j].scaleX = 1;
							scaled[j].y = 70;
						}
					}
				});
			trace("drawn");
		}
	}
}
