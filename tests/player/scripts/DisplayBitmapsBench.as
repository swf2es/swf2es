// A scene for timing bitmaps kept at display resolution (display-bitmaps.ts
// --write-bench): two bitmaps the stage's size, each made once by drawing
// still layers of vector art into it as content flattens a map, shown
// unsmoothed; one bitmap a quarter of the stage cleared and drawn into on
// every frame from a turning sprite; and sprites moving over all of it.
package
{
	import flash.display.Bitmap;
	import flash.display.BitmapData;
	import flash.display.Shape;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.geom.Matrix;
	import flash.geom.Rectangle;

	public class Main extends Sprite
	{
		private var _live:BitmapData;
		private var _turning:Sprite;
		private var _movers:Array = [];
		private var _frame:int = 0;

		public function Main()
		{
			var w:int = stage.stageWidth;
			var h:int = stage.stageHeight;
			for (var k:int = 0; k < 2; k++)
			{
				var data:BitmapData = new BitmapData(w, h, k == 1, k == 1 ? 0 : 0xFF336633);
				for (var layer:int = 0; layer < 3; layer++)
				{
					var art:Sprite = scatter(w, h, 900, k * 3 + layer);
					data.draw(art, new Matrix(1, 0, 0, 1, 0, 0), art.transform.colorTransform, null, new Rectangle(0, 0, w, h));
				}

				addChild(new Bitmap(data));
			}

			_live = new BitmapData(w / 2, h / 2, true, 0);
			_turning = scatter(w / 2, h / 2, 300, 7);
			var shown:Bitmap = new Bitmap(_live);
			shown.x = w / 4;
			shown.y = h / 4;
			addChild(shown);

			for (var i:int = 0; i < 40; i++)
			{
				var mover:Shape = new Shape();
				mover.graphics.beginFill(0xFFFFFF * ((i * 7919) % 97) / 97);
				mover.graphics.drawCircle(0, 0, 6 + i % 9);
				mover.graphics.endFill();
				mover.graphics.lineStyle(1, 0);
				mover.graphics.drawRect(-4, -4, 8, 8);
				addChild(mover);
				_movers.push(mover);
			}

			addEventListener(Event.ENTER_FRAME, onFrame);
		}

		private function onFrame(e:Event):void
		{
			_frame++;
			var w:Number = stage.stageWidth;
			var h:Number = stage.stageHeight;
			for (var i:int = 0; i < _movers.length; i++)
			{
				var mover:Shape = _movers[i];
				mover.x = (i * 97 + _frame * (2 + i % 5)) % w;
				mover.y = (i * 53 + Math.sin(_frame / 20 + i) * 40 + h) % h;
			}

			var m:Matrix = new Matrix();
			m.translate(-_live.width / 2, -_live.height / 2);
			m.rotate(_frame / 30);
			m.translate(_live.width / 2, _live.height / 2);
			_live.fillRect(_live.rect, 0);
			_live.draw(_turning, m, null, null, null);
		}

		/** `count` small things of vector art over `w` by `h`: blobs, roads, hairlines and dots. */
		private static function scatter(w:Number, h:Number, count:int, seed:int):Sprite
		{
			var layer:Sprite = new Sprite();
			var s:Shape = new Shape();
			layer.addChild(s);
			var r:uint = 12345 + seed * 7777;
			for (var i:int = 0; i < count; i++)
			{
				r = (r * 1103515245 + 12345) & 0x7FFFFFFF;
				var x:Number = r % w;
				r = (r * 1103515245 + 12345) & 0x7FFFFFFF;
				var y:Number = r % h;
				r = (r * 1103515245 + 12345) & 0x7FFFFFFF;
				var size:Number = 2 + r % 14;
				switch (i % 4)
				{
					case 0:
						s.graphics.lineStyle();
						s.graphics.beginFill(r & 0xFFFFFF, 0.8);
						s.graphics.drawCircle(x, y, size);
						s.graphics.endFill();
						break;
					case 1:
						s.graphics.lineStyle(3, r & 0xFFFFFF);
						s.graphics.moveTo(x, y);
						s.graphics.curveTo(x + size * 3, y - size * 2, x + size * 6, y);
						break;
					case 2:
						s.graphics.lineStyle(0, 0);
						s.graphics.moveTo(x, y);
						s.graphics.lineTo(x + size * 2, y + size * 3);
						break;
					default:
						s.graphics.lineStyle(1, 0x222222);
						s.graphics.beginFill(r & 0xFFFFFF);
						s.graphics.drawRect(x, y, size * 1.5, size);
						s.graphics.endFill();
				}
			}

			return layer;
		}
	}
}
