// How Flash covers a fill's edges at high quality, at the stage's scale and
// three times larger (cases.ts, edge-coverage): a disc's curve and a star's
// sharp corners against the background, a sliver thinner than a pixel, a
// translucent disc over stripes, and two fills abutting aslant, within one
// Shape and across two. Flash shows no seam either way: a pixel the edge
// crosses mixes the two fills alone, the background nowhere in it, as
// multisampling also covers it; drawing each object's edge coverage as its
// alpha would let the background through.
package
{
	import flash.display.Graphics;
	import flash.display.Shape;
	import flash.display.Sprite;

	public class EdgeCoverage extends Sprite
	{
		public function EdgeCoverage()
		{
			graphics.beginFill(0xffffff);
			graphics.drawRect(0, 0, 400, 240);
			graphics.endFill();

			addChild(row());
			const large:Sprite = row();
			large.y = 60;
			large.scaleX = large.scaleY = 3;
			addChild(large);
			trace("drawn");
		}

		private function row():Sprite
		{
			const sprite:Sprite = new Sprite();
			const shape:Shape = new Shape();
			const g:Graphics = shape.graphics;

			g.beginFill(0xcc3333);
			g.drawCircle(12, 12, 9.3);
			g.endFill();

			g.beginFill(0x223399);
			star(g, 36, 12, 10.5, 3.2, 5);
			g.endFill();

			// A sliver 0.6 wide, aslant.
			g.beginFill(0x111111);
			g.moveTo(52, 2);
			g.lineTo(52.6, 2);
			g.lineTo(60.6, 21);
			g.lineTo(60, 21);
			g.endFill();

			// Stripes, and a translucent disc over them.
			for (var i:int = 0; i < 4; i++)
			{
				g.beginFill(i % 2 == 0 ? 0x000000 : 0xffcc00);
				g.drawRect(66 + i * 5, 2, 5, 19);
				g.endFill();
			}

			g.beginFill(0x3399ff, 0.5);
			g.drawCircle(76, 12, 8.6);
			g.endFill();

			// Two fills of one Shape abutting aslant, the second shorter.
			g.beginFill(0x009966);
			g.moveTo(90, 2);
			g.lineTo(101.3, 2);
			g.lineTo(97.7, 21);
			g.lineTo(90, 21);
			g.endFill();
			g.beginFill(0x996600);
			g.moveTo(101.3, 2);
			g.lineTo(110, 2);
			g.lineTo(110, 15);
			g.lineTo(98.84, 15);
			g.endFill();
			sprite.addChild(shape);

			// Two Shapes abutting aslant along the same edge.
			const left:Shape = new Shape();
			left.graphics.beginFill(0x009966);
			left.graphics.moveTo(116, 2);
			left.graphics.lineTo(127.3, 2);
			left.graphics.lineTo(123.7, 21);
			left.graphics.lineTo(116, 21);
			left.graphics.endFill();
			sprite.addChild(left);
			const right:Shape = new Shape();
			right.graphics.beginFill(0x996600);
			right.graphics.moveTo(127.3, 2);
			right.graphics.lineTo(136, 2);
			right.graphics.lineTo(136, 21);
			right.graphics.lineTo(123.7, 21);
			right.graphics.endFill();
			sprite.addChild(right);
			return sprite;
		}

		private static function star(g:Graphics, x:Number, y:Number, outer:Number, inner:Number, points:int):void
		{
			for (var i:int = 0; i <= points * 2; i++)
			{
				const r:Number = i % 2 == 0 ? outer : inner;
				const a:Number = Math.PI * i / points - Math.PI / 2;
				if (i == 0)
				{
					g.moveTo(x + r * Math.cos(a), y + r * Math.sin(a));
				}
				else
				{
					g.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
				}
			}
		}
	}
}
