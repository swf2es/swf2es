package
{
	import flash.display.*;
	import flash.events.Event;
	import flash.geom.ColorTransform;
	import flash.geom.Matrix;

	// Shapes blended onto a gradient, each alone in its blend: a solid ellipse
	// part clear, a gradient rectangle turned, a circle filled with a bitmap,
	// and a drawing of two fills over each other, which its blend takes as one
	// picture, the overlap once. Every mode a fill may be drawn in straight
	// onto what is below, and subtract, which keeps its layer.
	public class BlendShapes extends Sprite
	{
		private static const MODES:Array = [
				"add", "screen", "multiply", "lighten", "darken", "difference",
				"overlay", "hardlight", "invert", "subtract"
			];

		public function BlendShapes()
		{
			var matrix:Matrix = new Matrix();
			matrix.createGradientBox(400, 200, 0.4, 0, 0);
			graphics.beginGradientFill(GradientType.LINEAR, [0x102040, 0xe0c060, 0x40a0d0], [1, 1, 1], [0, 128, 255], matrix);
			graphics.drawRect(0, 0, 400, 200);
			graphics.endFill();

			var data:BitmapData = new BitmapData(8, 8, false, 0x3060c0);
			for (var y:int = 0; y < 8; y++)
			{
				for (var x:int = 0; x < 8; x++)
				{
					if ((x + y) % 2 == 0)
					{
						data.setPixel(x, y, 0xf0c040);
					}
				}
			}

			var turned:Array = [];
			for (var i:int = 0; i < MODES.length; i++)
			{
				var left:Number = 6 + i * 39;

				var ellipse:Shape = new Shape();
				ellipse.graphics.beginFill(0xd04080, 0.7);
				ellipse.graphics.drawEllipse(0, 0, 32, 22);
				ellipse.graphics.endFill();
				ellipse.blendMode = MODES[i];
				ellipse.x = left;
				ellipse.y = 8;
				addChild(ellipse);

				var gradient:Shape = new Shape();
				var box:Matrix = new Matrix();
				box.createGradientBox(26, 16);
				gradient.graphics.beginGradientFill(GradientType.LINEAR, [0x20ff60, 0x8020ff], [1, 0.5], [0, 255], box);
				gradient.graphics.drawRect(-13, -8, 26, 16);
				gradient.graphics.endFill();
				var holder:Sprite = new Sprite();
				holder.addChild(gradient);
				holder.blendMode = MODES[i];
				holder.x = left + 16;
				holder.y = 58;
				holder.rotation = 30;
				holder.transform.colorTransform = new ColorTransform(1, 1, 0.8, 1, 0, 20, 0, 0);
				addChild(holder);
				turned.push(holder);

				var circle:Shape = new Shape();
				circle.graphics.beginBitmapFill(data, null, true, false);
				circle.graphics.drawCircle(16, 16, 15);
				circle.graphics.endFill();
				circle.blendMode = MODES[i];
				circle.x = left;
				circle.y = 84;
				addChild(circle);

				var two:Shape = new Shape();
				two.graphics.beginFill(0x40c0ff, 0.8);
				two.graphics.drawRect(0, 0, 24, 24);
				two.graphics.endFill();
				two.graphics.beginFill(0xff8020, 0.8);
				two.graphics.drawRect(10, 10, 24, 24);
				two.graphics.endFill();
				two.blendMode = MODES[i];
				two.x = left;
				two.y = 130;
				addChild(two);
			}

			var frame:int = 0;
			addEventListener(Event.ENTER_FRAME, function(event:Event):void
				{
					frame++;
					if (frame == 2)
					{
						for (var j:int = 0; j < turned.length; j++)
						{
							turned[j].rotation = -20;
							turned[j].y = 62;
						}
					}
				});
			trace("drawn");
		}
	}
}
