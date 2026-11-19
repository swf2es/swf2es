package
{
	import flash.display.Shape;
	import flash.display.Sprite;
	import flash.events.MouseEvent;
	import flash.external.ExternalInterface;
	import flash.text.TextField;
	import flash.text.TextFieldType;

	// The web test's focus rectangle SWF, 200 by 120: Tab goes to "clip", a
	// blue 40 by 30 sprite at (20, 20) under a green square over its left
	// edge; "kid", 10 by 10 in a holder scaled twice at (100, 20); "off", at
	// (20, 70), whose focusRect is false; and an input field at (100, 70).
	// A press on the red square at (170, 20) focuses the clip from its
	// mouseDown, one on the one at (170, 70) the stage.
	public class FocusRectTest extends Sprite
	{
		private function box(color:uint, width:Number, height:Number):Shape
		{
			var s:Shape = new Shape();
			s.graphics.beginFill(color);
			s.graphics.drawRect(0, 0, width, height);
			return s;
		}

		private function clickable(name:String, width:Number, height:Number):Sprite
		{
			var s:Sprite = new Sprite();
			s.name = name;
			s.buttonMode = true;
			s.addChild(box(0x0000ff, width, height));
			return s;
		}

		public function FocusRectTest()
		{
			var clip:Sprite = clickable("clip", 40, 30);
			clip.x = 20;
			clip.y = 20;
			addChild(clip);

			var holder:Sprite = new Sprite();
			holder.x = 100;
			holder.y = 20;
			holder.scaleX = 2;
			holder.scaleY = 2;
			holder.addChild(clickable("kid", 10, 10));
			addChild(holder);

			var off:Sprite = clickable("off", 40, 30);
			off.x = 20;
			off.y = 70;
			off.focusRect = false;
			addChild(off);

			var field:TextField = new TextField();
			field.name = "field";
			field.type = TextFieldType.INPUT;
			field.border = true;
			field.x = 100;
			field.y = 70;
			field.width = 60;
			field.height = 20;
			addChild(field);

			var cover:Shape = box(0x00ff00, 20, 20);
			cover.x = 10;
			cover.y = 25;
			addChild(cover);

			var pad:Sprite = new Sprite();
			pad.addChild(box(0xff0000, 20, 20));
			pad.x = 170;
			pad.y = 20;
			pad.addEventListener(MouseEvent.MOUSE_DOWN, function(e:MouseEvent):void
				{
					stage.focus = clip;
				});
			addChild(pad);

			var stagePad:Sprite = new Sprite();
			stagePad.addChild(box(0xff0000, 20, 20));
			stagePad.x = 170;
			stagePad.y = 70;
			stagePad.addEventListener(MouseEvent.MOUSE_DOWN, function(e:MouseEvent):void
				{
					stage.focus = stage;
				});
			addChild(stagePad);

			var self:Sprite = this;
			ExternalInterface.addCallback("focusName", function():String
				{
					var focus:Object = stage.focus;
					return focus == null ? "null" : focus == stage ? "stage" : focus == self ? "root" : focus.name;
				});
			ExternalInterface.addCallback("focusOn", function(name:String):void
				{
					switch (name)
					{
						case "stage":
							stage.focus = stage;
							break;
						case "root":
							stage.focus = self;
							break;
						case "kid":
							stage.focus = Sprite(holder.getChildAt(0));
							break;
						default:
							stage.focus = Sprite(getChildByName(name));
					}
				});
			ExternalInterface.addCallback("showHolder", function(on:Boolean):void
				{
					holder.visible = on;
				});
			ExternalInterface.addCallback("nudge", function():void
				{
					clip.x += 10;
				});
			ExternalInterface.addCallback("stageFocusRect", function(on:Boolean):void
				{
					stage.stageFocusRect = on;
				});
		}
	}
}
