package
{
	import flash.display.DisplayObject;
	import flash.display.Shape;
	import flash.display.SimpleButton;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.MouseEvent;

	// Boxes "a" holding "a1", "b", "c" holding "c1" holding "c2", and a
	// SimpleButton "btn": the stage traces the mouse events it hears, each
	// object its roll events; cmd changes them between frames. In Flash, the
	// probe also logged each line, and took cmd, through ExternalInterface.
	public class MouseGaps extends Sprite
	{
		private var named:Object = {};

		private function box(name:String, x:Number, y:Number, size:Number):Sprite
		{
			var s:Sprite = new Sprite();
			s.name = name;
			var art:Shape = new Shape();
			art.graphics.beginFill(0xff0000);
			art.graphics.drawRect(0, 0, size, size);
			s.addChild(art);
			s.x = x;
			s.y = y;
			named[name] = s;
			return s;
		}

		// Flash's float noise left out: 50.000003814697266 is 50.
		private function round(n:Number):Number
		{
			return Math.round(n * 1000) / 1000;
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
				line += " " + nameOf(m.relatedObject) + " " + m.buttonDown + " " + round(m.localX) + "," + round(m.localY);
				if (e.type == "mouseWheel")
				{
					line += " " + m.delta;
				}
			}

			trace(line + " @" + stage.mouseX + "," + stage.mouseY);
		}

		private function state(color:uint):Shape
		{
			var s:Shape = new Shape();
			s.graphics.beginFill(color);
			s.graphics.drawRect(0, 0, 80, 80);
			return s;
		}

		public function cmd(op:String, name:String, key:String, value:*):void
		{
			var o:Object = name == "root" ? this : name == "stage" ? stage : named[name];
			switch (op)
			{
				case "listen":
					o.addEventListener(key, heard);
					break;
				case "set":
					o[key] = value;
					break;
				case "remove":
					o.parent.removeChild(DisplayObject(o));
					break;
				case "add":
					(key == "stage" ? stage : key ? named[key] : this).addChild(DisplayObject(o));
					break;
				case "draw":
					var r:Array = String(value).split(",");
					o.graphics.beginFill(0x808080);
					o.graphics.drawRect(r[0], r[1], r[2], r[3]);
					break;
			}
		}

		public function MouseGaps()
		{
			var a:Sprite = box("a", 0, 0, 80);
			a.addChild(box("a1", 20, 20, 40));
			addChild(a);
			addChild(box("b", 100, 0, 80));
			var c:Sprite = box("c", 0, 100, 90);
			var c1:Sprite = box("c1", 20, 20, 50);
			c1.addChild(box("c2", 20, 20, 20));
			c.addChild(c1);
			addChild(c);
			var btn:SimpleButton = new SimpleButton(state(0xff0000), state(0x00ff00), state(0x0000ff), state(0));
			btn.name = "btn";
			btn.x = 200;
			named.btn = btn;
			addChild(btn);
			for each (var type:String in ["mouseDown", "mouseUp", "click", "doubleClick", "mouseMove", "mouseOver", "mouseOut", "mouseWheel"])
			{
				stage.addEventListener(type, heard);
			}

			for each (var o:Object in [stage, this, a, named.a1, named.b, c, c1, named.c2, btn])
			{
				o.addEventListener("rollOver", heard);
				o.addEventListener("rollOut", heard);
			}

			stage.addEventListener("mouseLeave", heard);
		}
	}
}
