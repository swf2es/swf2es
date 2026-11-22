// Vector art drawn into a BitmapData the stage's size and shown through an
// unsmoothed Bitmap scaled to the art's size, as content flattens a map's
// still layers: on the left the bitmap, on the right the same art drawn as
// vectors. The bitmap takes the stage's width and a height in proportion,
// each layer drawn through a matrix that fits it, its own colour transform
// and a clip of the bitmap's size. Thirty frames on a grid of its pixels is
// traced, which reads it back, and a marker filled: what scripts see of it
// at its size, and how it shows after.
package
{
	import flash.display.Bitmap;
	import flash.display.BitmapData;
	import flash.display.GradientType;
	import flash.display.Shape;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.geom.Matrix;
	import flash.geom.Rectangle;

	public class Main extends Sprite
	{
		/** The art's own size, in its units. */
		private static const ART_WIDTH:Number = 400;
		private static const ART_HEIGHT:Number = 480;

		private var _data:BitmapData;
		private var _frame:int = 0;

		public function Main()
		{
			var left:Sprite = new Sprite();
			var right:Sprite = new Sprite();
			var fit:Number = (stage.stageWidth / 2) / ART_WIDTH;
			left.scaleX = left.scaleY = fit;
			right.scaleX = right.scaleY = fit;
			right.x = stage.stageWidth / 2;
			addChild(left);
			addChild(right);

			var ground:Sprite = art(0);
			var details:Sprite = art(1);
			left.addChild(ground);
			left.addChild(details);
			right.addChild(art(0));
			right.addChild(art(1));

			var w:int = stage.stageWidth / 2;
			var h:int = w * ART_HEIGHT / ART_WIDTH;
			_data = new BitmapData(w, h, true, 0);
			const layers:Array = [ground, details];
			for (var i:int = 0; i < layers.length; i++)
			{
				var layer:Sprite = layers[i];
				_data.draw(layer, new Matrix(w / ART_WIDTH, 0, 0, h / ART_HEIGHT, 0, 0), layer.transform.colorTransform, null, new Rectangle(0, 0, w, h));
			}

			var shown:Bitmap = new Bitmap(_data);
			shown.width = ART_WIDTH;
			shown.height = ART_HEIGHT;
			left.addChildAt(shown, left.getChildIndex(ground));
			left.removeChild(ground);
			left.removeChild(details);
			addEventListener(Event.ENTER_FRAME, onFrame);
		}

		private function onFrame(e:Event):void
		{
			_frame++;
			if (_frame != 30)
			{
				return;
			}

			var line:Array = [];
			for (var y:int = 5; y < _data.height; y += 20)
			{
				for (var x:int = 5; x < _data.width; x += 20)
				{
					line.push(_data.getPixel32(x, y).toString(16));
				}
			}

			trace("pixels " + line.join(" "));
			_data.fillRect(new Rectangle(4, 4, 6, 6), 0xFFFF00FF);
		}

		/** A layer of the art: 0 the ground, 1 the details over it. */
		private static function art(kind:int):Sprite
		{
			var layer:Sprite = new Sprite();
			var s:Shape = new Shape();
			layer.addChild(s);
			if (kind == 0)
			{
				var m:Matrix = new Matrix();
				m.createGradientBox(ART_WIDTH, ART_HEIGHT, Math.PI / 3);
				s.graphics.beginGradientFill(GradientType.LINEAR, [0x2E7D32, 0xC5E1A5], [1, 1], [0, 255], m);
				s.graphics.drawRect(0, 0, ART_WIDTH, ART_HEIGHT);
				s.graphics.endFill();
				s.graphics.beginFill(0x4FC3F7);
				s.graphics.moveTo(0, 300);
				s.graphics.curveTo(120, 250, 200, 320);
				s.graphics.curveTo(300, 400, ART_WIDTH, 340);
				s.graphics.lineTo(ART_WIDTH, 380);
				s.graphics.curveTo(300, 440, 200, 360);
				s.graphics.curveTo(120, 290, 0, 340);
				s.graphics.endFill();
				return layer;
			}

			// Roads a few units wide, hairline paths, small houses and trees, a dotted path.
			s.graphics.lineStyle(6, 0x8D6E63);
			s.graphics.moveTo(20, 40);
			s.graphics.curveTo(200, 120, 380, 60);
			s.graphics.lineStyle(2, 0xFFFFFF);
			s.graphics.moveTo(20, 40);
			s.graphics.curveTo(200, 120, 380, 60);
			s.graphics.lineStyle(0, 0x000000);
			for (var k:int = 0; k < 12; k++)
			{
				s.graphics.moveTo(30 + k * 30, 150);
				s.graphics.lineTo(45 + k * 30, 230);
			}

			s.graphics.lineStyle(1, 0x3E2723);
			for (var j:int = 0; j < 6; j++)
			{
				var hx:Number = 40 + j * 58;
				s.graphics.beginFill(0xFFCC80);
				s.graphics.drawRect(hx, 400, 22, 18);
				s.graphics.endFill();
				s.graphics.beginFill(0xD84315);
				s.graphics.moveTo(hx - 3, 400);
				s.graphics.lineTo(hx + 11, 389);
				s.graphics.lineTo(hx + 25, 400);
				s.graphics.lineTo(hx - 3, 400);
				s.graphics.endFill();
			}

			s.graphics.lineStyle();
			for (var t:int = 0; t < 9; t++)
			{
				s.graphics.beginFill(0x1B5E20);
				s.graphics.drawCircle(50 + t * 38, 260 + (t % 3) * 8, 9);
				s.graphics.endFill();
				s.graphics.beginFill(0x000000, 0.6);
				s.graphics.drawCircle(50 + t * 38, 275 + (t % 3) * 8, 1.5);
				s.graphics.endFill();
			}

			for (var d:int = 0; d < 40; d++)
			{
				s.graphics.beginFill(0xFFFFFF);
				s.graphics.drawCircle(20 + d * 9.2, 120 + Math.sin(d / 3) * 10, 1.2);
				s.graphics.endFill();
			}

			return layer;
		}
	}
}
