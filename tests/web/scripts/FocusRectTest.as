package
{
	import flash.display.Shape;
	import flash.display.Sprite;
	import flash.external.ExternalInterface;
	import flash.text.TextField;
	import flash.text.TextFieldType;

	// The web test's focus rectangle SWF, 200 by 120: Tab goes to "clip", a
	// blue 40 by 30 sprite at (20, 20) under a green square over its left
	// edge; "kid", 10 by 10 in a holder scaled twice at (100, 20); "off", at
	// (20, 70), whose focusRect is false; and an input field at (100, 70).
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

			ExternalInterface.addCallback("focusName", function():String
				{
					return stage.focus ? stage.focus.name : "null";
				});
			ExternalInterface.addCallback("focusOn", function(name:String):void
				{
					stage.focus = name == "kid" ? Sprite(holder.getChildAt(0)) : Sprite(getChildByName(name));
				});
			ExternalInterface.addCallback("stageFocusRect", function(on:Boolean):void
				{
					stage.stageFocusRect = on;
				});
		}
	}
}
