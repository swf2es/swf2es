// leak.ts's bitmaps mode: every other frame a card, a Sprite that draws its
// own child art into a BitmapData of its own and shows it scaled up over the
// art, which it keeps, is put
// on the stage, the oldest of four taken off and dropped, never disposed: on
// a renderer that shows bitmaps at the display's resolution, each card's
// texture and what drew it must go with the card. A line traced a card.
package
{
	import flash.display.Sprite;
	import flash.events.Event;

	public class LeakBitmaps extends Sprite
	{
		private var _cards:Array = [];
		private var _frame:int = 0;
		private var _made:int = 0;

		public function LeakBitmaps()
		{
			addEventListener(Event.ENTER_FRAME, onFrame);
		}

		private function onFrame(e:Event):void
		{
			_frame++;
			if (_frame % 2 != 0)
			{
				return;
			}

			var card:LeakCard = new LeakCard(_made);
			card.x = (_made % 4) * 30;
			addChild(card);
			_cards.push(card);
			if (_cards.length > 4)
			{
				removeChild(_cards.shift());
			}

			_made++;
			trace("card " + _made);
		}
	}
}

import flash.display.Bitmap;
import flash.display.BitmapData;
import flash.display.Shape;
import flash.display.Sprite;

class LeakCard extends Sprite
{
	public var data:BitmapData;
	private var _art:Sprite = new Sprite();

	public function LeakCard(n:int)
	{
		var s:Shape = new Shape();
		for (var i:int = 0; i < 40; i++)
		{
			s.graphics.beginFill((n * 7919 + i * 104729) & 0xFFFFFF);
			s.graphics.drawCircle((i * 13) % 200, (i * 29) % 150, 4 + i % 9);
			s.graphics.endFill();
		}

		_art.addChild(s);
		addChild(_art);
		data = new BitmapData(200, 150, true, 0);
		data.draw(_art);
		var shown:Bitmap = new Bitmap(data);
		shown.scaleX = shown.scaleY = 2;
		addChild(shown);
	}
}
