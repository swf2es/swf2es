package
{
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.MouseEvent;
	import flash.events.TouchEvent;
	import flash.system.System;
	import flash.ui.Multitouch;

	public class TouchMain extends Sprite
	{
		private function box(name:String, x:Number, size:Number):Sprite
		{
			var s:Sprite = new Sprite();
			s.name = name;
			s.graphics.beginFill(0xff0000);
			s.graphics.drawRect(0, 0, size, size);
			s.x = x;
			return s;
		}

		private function heard(e:Event):void
		{
			var line:String = e.type + " " + e.target.name;
			if (e is TouchEvent)
			{
				var t:TouchEvent = TouchEvent(e);
				line += " " + t.touchPointID + " " + t.isPrimaryTouchPoint + " " + t.localX + "," + t.localY + " " + t.sizeX + "," + t.sizeY + " " + t.pressure;
				// AIR's isTouchPointCanceled, which a Flash Player SWF reads only in the event's string.
				if (String(t).indexOf("isTouchPointCanceled=true") >= 0)
				{
					line += " canceled";
				}
			}

			trace(line);
		}

		public function TouchMain()
		{
			trace(Multitouch.supportsTouchEvents, Multitouch.maxTouchPoints, Multitouch.inputMode);
			Multitouch.inputMode = "touchPoint";
			trace(Multitouch.inputMode);
			Multitouch.inputMode = "none";
			trace(Multitouch.inputMode);
			var a:Sprite = box("a", 0, 40);
			var b:Sprite = box("b", 10, 20);
			b.y = 10;
			a.addChild(b);
			addChild(a);
			addChild(box("c", 50, 40));
			for each (var type:String in ["mouseDown", "mouseUp", "click", "mouseMove", "mouseOver", "mouseOut",
						"touchBegin", "touchEnd", "touchMove", "touchOver", "touchOut", "touchTap"])
			{
				stage.addEventListener(type, heard);
			}

			a.addEventListener("touchRollOver", heard);
			a.addEventListener("touchRollOut", heard);
			stage.addEventListener("touchTap", function(e:TouchEvent):void
				{
					System.setClipboard("tapped");
				});
			stage.addEventListener("touchOver", function(e:TouchEvent):void
				{
					try
					{
						System.setClipboard("over");
					}
					catch (err:Error)
					{
						trace("no clipboard in touchOver");
					}
				});
		}
	}
}
