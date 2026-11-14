package
{
	import flash.display.Screen;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.geom.Rectangle;

	public class Facts extends Sprite
	{
		private function found(x:Number, y:Number, width:Number, height:Number):int
		{
			return Screen.getScreensForRectangle(new Rectangle(x, y, width, height)).length;
		}

		public function Facts()
		{
			var main:Screen = Screen.mainScreen;
			var b:Rectangle = main.bounds;
			var v:Rectangle = main.visibleBounds;
			trace("new each call", Screen.screens === Screen.screens, Screen.screens[0] === Screen.screens[0], Screen.mainScreen === Screen.mainScreen, Screen.screens.indexOf(Screen.mainScreen));
			trace("screens", Screen.screens.length, Screen.screens[0] is Screen, Screen.screens[0].bounds.equals(b), String(main));
			trace("bounds", b.x, b.y, b.width > 0, b.height > 0, b.containsRect(v), b.equals(v), typeof main.colorDepth, main.colorDepth > 0);
			trace("kept", main.bounds === b, main.visibleBounds === v, Screen.mainScreen.bounds === b, Screen.mainScreen.bounds.equals(b));
			try
			{
				trace(new Screen());
			}
			catch (e:Error)
			{
				trace("new Screen", e);
			}

			var all:Array = Screen.getScreensForRectangle(b);
			trace("found", all.length, all[0] is Screen, all[0] === main, all[0].bounds.equals(b), Screen.getScreensForRectangle(b) === all);
			trace("inside", found(10, 10, 10, 10), found(0, 0, 1, 1), found(-100000, -100000, 300000, 300000));
			trace("no area", found(10, 10, 0, 0), found(10, 10, 0, 10), found(10, 10, 10, 0), found(10, 10, -5, -5), found(-5, -5, -5, -5));
			trace("touching", found(-10, 0, 10, 10), found(0, -10, 10, 10), found(b.right, 0, 10, 10), found(0, b.bottom, 10, 10));
			trace("a pixel in", found(-10, 0, 11, 10), found(0, -10, 10, 11), found(b.right - 1, 0, 10, 10), found(0, b.bottom - 1, 10, 10));
			trace("outside", found(-100000, -100000, 10, 10), found(b.right + 100000, 0, 10, 10));
			trace("rounded widths", found(-10, 0, 10.4, 10), found(-10, 0, 10.5, 10), found(-10, 0, 10.6, 10), found(-12, 0, 11.5, 10), found(-12, 0, 12.5, 10));
			trace("rounded places", found(-11.5, 0, 12, 10), found(-12.5, 0, 13, 10), found(-12.5, 0, 12, 10), found(-10.6, 0, 11, 10));
			trace("rounded apart", found(10.6, 10.6, 0.8, 0.8), found(10.4, 10.4, 0.2, 0.2), found(10.5, 10.5, 0.2, 0.2), found(10, 10, 1.5, 1.5), found(10, 10, 0.5, 10), found(10, 10, 0.51, 0.51));
			trace("past an int", found(3e9, 0, 10, 10), found(-3e9, 0, 3e9 + 10, 10), found(10, 10, 4294967306, 10), found(10, 10, 2147483648, 10), found(10, 10, 2147483647, 10), found(-5, 10, 2147483000, 10));
			trace("not finite", found(NaN, NaN, NaN, NaN), found(10, 10, NaN, NaN), found(10, 10, Infinity, Infinity), found(-Infinity, 0, Infinity, 10));
			b.width = 1;
			v.x = 77;
			trace("changed", main.bounds.width, main.visibleBounds.x, Screen.mainScreen.bounds.width > 1, found(500, 10, 10, 10));
			main.addEventListener(Event.CHANGE, function(e:Event):void
				{
					trace("dispatched", e.type, e.target === main);
				});
			trace("listens", main.hasEventListener(Event.CHANGE), main.dispatchEvent(new Event(Event.CHANGE)));
			var frames:int = 0;
			addEventListener(Event.ENTER_FRAME, function(e:Event):void
				{
					if (++frames == 3)
					{
						trace("frame 3", main.bounds === b, b.width);
					}
				});
		}
	}
}
