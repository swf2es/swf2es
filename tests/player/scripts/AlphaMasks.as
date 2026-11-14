package
{
	import flash.display.*;
	import flash.filters.BlurFilter;
	import flash.geom.*;

	public class AlphaMasks extends Sprite
	{
		private function cell(i:int):Point
		{
			return new Point((i % 4) * 100, int(i / 4) * 100);
		}

		private function maskee(at:Point):Sprite
		{
			var r:Sprite = new Sprite();
			r.graphics.beginFill(0xff0000);
			r.graphics.drawRect(at.x + 10, at.y + 10, 80, 80);
			return r;
		}

		/** A rect whose alpha falls from 1 at its left to 0 at its right. */
		private function gradient(at:Point):Shape
		{
			var m:Shape = new Shape();
			var matrix:Matrix = new Matrix();
			matrix.createGradientBox(80, 80, 0, at.x + 10, at.y + 10);
			m.graphics.beginGradientFill(GradientType.LINEAR, [0x0000ff, 0x0000ff], [1, 0], [0, 255], matrix);
			m.graphics.drawRect(at.x + 10, at.y + 10, 80, 80);
			return m;
		}

		private function pair(i:int, maskCached:Boolean, maskeeCached:Boolean):Array
		{
			var at:Point = cell(i);
			var r:Sprite = maskee(at);
			var m:Shape = gradient(at);
			addChild(r);
			addChild(m);
			r.mask = m;
			m.cacheAsBitmap = maskCached;
			r.cacheAsBitmap = maskeeCached;
			return [r, m];
		}

		public function AlphaMasks()
		{
			pair(0, false, false);
			pair(1, true, false);
			pair(2, false, true);
			pair(3, true, true);

			var p:Array = pair(4, false, true);
			p[1].filters = [new BlurFilter(0, 0)];
			p = pair(5, false, false);
			p[0].filters = [new BlurFilter(0, 0)];
			p[1].filters = [new BlurFilter(0, 0)];
			p = pair(6, true, true);
			p[1].alpha = 0.5;
			p = pair(7, true, true);
			p[1].transform.colorTransform = new ColorTransform(1, 1, 1, 0.5);

			// A container mask of two overlapping half-transparent squares.
			var at:Point = cell(8);
			var r:Sprite = maskee(at);
			var m:Sprite = new Sprite();
			m.graphics.beginFill(0x0000ff, 0.5);
			m.graphics.drawRect(at.x + 10, at.y + 10, 50, 80);
			m.graphics.beginFill(0x0000ff, 0.5);
			m.graphics.drawRect(at.x + 40, at.y + 10, 50, 80);
			addChild(r);
			addChild(m);
			r.mask = m;
			m.cacheAsBitmap = true;
			r.cacheAsBitmap = true;

			// A mask on no display list.
			at = cell(9);
			r = maskee(at);
			addChild(r);
			var off:Shape = gradient(at);
			r.mask = off;
			off.cacheAsBitmap = true;
			r.cacheAsBitmap = true;

			// Only the maskee's parent cached.
			at = cell(10);
			var holder:Sprite = new Sprite();
			addChild(holder);
			r = maskee(at);
			holder.addChild(r);
			var hm:Shape = gradient(at);
			addChild(hm);
			r.mask = hm;
			hm.cacheAsBitmap = true;
			holder.cacheAsBitmap = true;

			// Both cached, the mask moved half a cell right after.
			p = pair(11, true, true);
			p[1].x = 40;

			trace("cacheAsBitmap", p[0].cacheAsBitmap, p[1].cacheAsBitmap);
		}
	}
}
