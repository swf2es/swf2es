// Vector art drawn into a BitmapData and shown through an unsmoothed Bitmap
// scaled to the art's size, as content flattens a map's still layers: in the
// top 240 rows, on the left the bitmap, on the right the same art drawn as
// vectors. The bitmap takes about the half's width and a height in
// proportion, each layer drawn through a matrix that fits it, its own colour
// transform and a clip of the bitmap's size.
//
// Below them, bitmaps shown larger than a pixel a stage pixel that go other
// ways: one cleared and drawn into from a turning sprite on every frame; one
// whose first draw is of a sprite that shows that bitmap itself; one
// disposed on frame 25; one whose Bitmap is scaled up on frame 12; a copy of
// the main bitmap's pixels made on frame 20; and a shape filled with the main
// bitmap. On frame 30 the main bitmap, the drawn-into one, the one that drew
// itself and the copy are traced as grids of pixels, which reads them back,
// and a marker is filled into the main one.
package
{
	import flash.display.Bitmap;
	import flash.display.BitmapData;
	import flash.display.GradientType;
	import flash.display.Shape;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.geom.Matrix;
	import flash.geom.Point;
	import flash.geom.Rectangle;

	public class Main extends Sprite
	{
		/** The art's own size, in its units. */
		private static const ART_WIDTH:Number = 400;
		private static const ART_HEIGHT:Number = 480;

		private var _data:BitmapData;
		private var _live:BitmapData;
		private var _self:BitmapData;
		private var _spare:BitmapData;
		private var _copy:BitmapData;
		private var _turning:Sprite;
		private var _strip:Sprite;
		private var _grow:Bitmap;
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

			// A little smaller than the half it shows in, so it is shown a little larger than a pixel a
			// stage pixel, as a bitmap sized to a map's size often is.
			var w:int = stage.stageWidth / 2 * 0.9;
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

			_strip = new Sprite();
			_strip.y = 250;
			addChild(_strip);
			_turning = blobs(60, 40);
			_live = new BitmapData(60, 40, true, 0);
			strip(_live, 5, 1.25);
			_self = new BitmapData(60, 40, true, 0);
			strip(_self, 90, 1.25);
			_spare = new BitmapData(40, 30, true, 0);
			_spare.draw(blobs(40, 30));
			strip(_spare, 175, 1.4);
			var grown:BitmapData = new BitmapData(40, 30, true, 0);
			grown.draw(blobs(40, 30));
			_grow = strip(grown, 240, 1);
			var filled:Shape = new Shape();
			filled.graphics.beginBitmapFill(_data, new Matrix(0.25, 0, 0, 0.25));
			filled.graphics.drawRect(0, 0, 40, 40);
			filled.graphics.endFill();
			filled.x = 300;
			_strip.addChild(filled);
			addEventListener(Event.ENTER_FRAME, onFrame);
		}

		/** A Bitmap of `data` in the strip at `x`, scaled by `scale`. */
		private function strip(data:BitmapData, x:Number, scale:Number):Bitmap
		{
			var shown:Bitmap = new Bitmap(data);
			shown.x = x;
			shown.scaleX = shown.scaleY = scale;
			_strip.addChild(shown);
			return shown;
		}

		private function onFrame(e:Event):void
		{
			_frame++;
			var m:Matrix = new Matrix();
			m.translate(-30, -20);
			m.rotate(_frame / 7);
			m.translate(30, 20);
			_live.fillRect(_live.rect, 0);
			_live.draw(_turning, m);
			switch (_frame)
			{
				case 3:
					// The strip, this bitmap's own Bitmap in it, drawn into it.
					_self.draw(_strip, new Matrix(0.2, 0, 0, 0.2, 0, 0));
					break;
				case 12:
					_grow.scaleX = _grow.scaleY = 1.4;
					break;
				case 20:
					_copy = new BitmapData(_data.width, _data.height, true, 0);
					_copy.copyPixels(_data, _data.rect, new Point(0, 0));
					break;
				case 25:
					_spare.dispose();
					break;
				case 30:
					trace("pixels " + grid(_data, 20));
					trace("live " + grid(_live, 7));
					trace("self " + grid(_self, 7));
					trace("copy " + grid(_copy, 20));
					_data.fillRect(new Rectangle(4, 4, 6, 6), 0xFFFF00FF);
					break;
			}
		}

		/** `data`'s pixels every `step` from (5, 5), in hexadecimal. */
		private static function grid(data:BitmapData, step:int):String
		{
			var line:Array = [];
			for (var y:int = 5; y < data.height; y += step)
			{
				for (var x:int = 5; x < data.width; x += step)
				{
					line.push(data.getPixel32(x, y).toString(16));
				}
			}

			return line.join(" ");
		}

		/** Coloured blobs and a hairline over `w` by `h`. */
		private static function blobs(w:Number, h:Number):Sprite
		{
			var sprite:Sprite = new Sprite();
			var s:Shape = new Shape();
			sprite.addChild(s);
			for (var i:int = 0; i < 6; i++)
			{
				s.graphics.beginFill([0xE53935, 0x1E88E5, 0x43A047][i % 3], 0.8);
				s.graphics.drawCircle(w * (i + 1) / 7, h / 2 + (i % 2 ? 5 : -5), 6 + i);
				s.graphics.endFill();
			}

			s.graphics.lineStyle(0, 0);
			s.graphics.moveTo(2, 2);
			s.graphics.lineTo(w - 2, h - 2);
			return sprite;
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
