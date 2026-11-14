// An inner drop shadow that hides its object draws as a knocked-out one:
// the shadow alone, within the object, what is under it showing through.
// The same through applyFilter, its pixels traced.
package
{
	import flash.display.BitmapData;
	import flash.display.Shape;
	import flash.display.Sprite;
	import flash.filters.DropShadowFilter;
	import flash.geom.Point;
	import flash.geom.Rectangle;

	public class Main extends Sprite
	{
		public function Main()
		{
			for (var i:int = 0; i < 8; i++)
			{
				graphics.beginFill(i % 2 ? 0x40c040 : 0xc04040);
				graphics.drawRect(i * 50, 0, 50, 200);
				graphics.endFill();
			}

			box(10, new DropShadowFilter(5, 103, 0x000000, 1, 40, 40, 1, 1, true, false, true));
			box(210, new DropShadowFilter(5, 103, 0x000000, 1, 40, 40, 1, 1, true, true, false));

			const src:BitmapData = new BitmapData(100, 60, true, 0);
			src.fillRect(new Rectangle(0, 0, 100, 60), 0xffffffff);
			const hidden:BitmapData = new BitmapData(100, 60, true, 0);
			hidden.applyFilter(src, src.rect, new Point(), new DropShadowFilter(5, 103, 0, 1, 20, 20, 1, 1, true, false, true));
			const knocked:BitmapData = new BitmapData(100, 60, true, 0);
			knocked.applyFilter(src, src.rect, new Point(), new DropShadowFilter(5, 103, 0, 1, 20, 20, 1, 1, true, true, false));
			const points:Array = [[2, 2], [50, 30], [98, 58], [50, 3]];
			for (var k:int = 0; k < points.length; k++)
			{
				const p:Array = points[k];
				trace("at", p, "hidden", hidden.getPixel32(p[0], p[1]).toString(16), "knocked out", knocked.getPixel32(p[0], p[1]).toString(16));
			}
		}

		private function box(x:Number, filter:DropShadowFilter):void
		{
			const holder:Sprite = new Sprite();
			const shape:Shape = new Shape();
			shape.graphics.beginFill(0xffffff);
			shape.graphics.drawRect(0, 0, 180, 180);
			shape.graphics.endFill();
			holder.addChild(shape);
			holder.x = x;
			holder.y = 10;
			holder.filters = [filter];
			addChild(holder);
		}
	}
}
