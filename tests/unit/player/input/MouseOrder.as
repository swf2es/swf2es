package
{
	import flash.display.Shape;
	import flash.display.SimpleButton;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.MouseEvent;

	public class MouseOrder extends Sprite
	{
		private function box(name:String, x:Number, y:Number, size:Number):Sprite
		{
			var s:Sprite = new Sprite();
			s.name = name;
			s.graphics.beginFill(0xff0000);
			s.graphics.drawRect(0, 0, size, size);
			s.x = x;
			s.y = y;
			return s;
		}

		private function nameOf(o:Object):String
		{
			return o == null ? "null" : o == stage ? "stage" : o == this ? "root" : o.name;
		}

		private function heard(e:Event):void
		{
			var line:String = e.type + " " + nameOf(e.target);
			if (e is MouseEvent)
			{
				var m:MouseEvent = MouseEvent(e);
				line += " " + nameOf(m.relatedObject) + " " + m.buttonDown + " " + m.localX + "," + m.localY;
			}

			trace(line + " @" + stage.mouseX + "," + stage.mouseY);
		}

		public function MouseOrder()
		{
			var a:Sprite = box("a", 0, 0, 80);
			a.addChild(box("a1", 20, 20, 40));
			addChild(a);
			addChild(box("b", 100, 0, 80));
			var hit:Shape = new Shape();
			hit.graphics.beginFill(0);
			hit.graphics.drawRect(0, 0, 80, 80);
			var btn:SimpleButton = new SimpleButton(hit, hit, hit, hit);
			btn.name = "btn";
			btn.x = 200;
			addChild(btn);
			for each (var type:String in ["mouseDown", "mouseUp", "click", "mouseMove", "mouseOver", "mouseOut"])
			{
				stage.addEventListener(type, heard);
			}

			for each (var o:Object in [stage, this, a, a.getChildAt(0), getChildAt(1), btn])
			{
				o.addEventListener("rollOver", heard);
				o.addEventListener("rollOut", heard);
			}

			stage.addEventListener("mouseLeave", heard);
		}
	}
}
