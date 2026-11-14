package
{
	import flash.display.Sprite;
	import flash.events.TouchEvent;
	import flash.geom.Rectangle;
	import flash.ui.Multitouch;

	public class TouchDragMain extends Sprite
	{
		private function box(x:Number):Sprite
		{
			var s:Sprite = new Sprite();
			s.graphics.beginFill(0xff0000);
			s.graphics.drawRect(0, 0, 20, 20);
			s.x = x;
			addChild(s);
			return s;
		}

		public function TouchDragMain()
		{
			Multitouch.inputMode = "touchPoint";
			var a:Sprite = box(0);
			var b:Sprite = box(50);
			a.addEventListener("touchBegin", function(e:TouchEvent):void
				{
					a.startTouchDrag(e.touchPointID);
				});
			b.addEventListener("touchBegin", function(e:TouchEvent):void
				{
					b.startTouchDrag(e.touchPointID, true, new Rectangle(40, 0, 20, 10));
				});
			b.addEventListener("touchEnd", function(e:TouchEvent):void
				{
					b.stopTouchDrag(e.touchPointID);
				});
			for each (var type:String in ["touchBegin", "touchMove", "touchEnd"])
			{
				stage.addEventListener(type, function(e:TouchEvent):void
					{
						trace(e.type, e.touchPointID, a.x + "," + a.y, b.x + "," + b.y, a.dropTarget == b);
					});
			}
		}
	}
}
