package
{
	import flash.display.Loader;
	import flash.display.Sprite;
	import flash.events.Event;
	import flash.events.EventPhase;
	import flash.events.FocusEvent;
	import flash.events.KeyboardEvent;
	import flash.events.TextEvent;
	import flash.net.URLRequest;
	import flash.text.TextField;
	import flash.text.TextFieldType;

	// An AS3 host of an AVM1 movie's input fields, with an input field of its own below them:
	// what the stage hears of keys and focus.
	public class LoadedAvm1Keys extends Sprite
	{
		private var _loader:Loader = new Loader();
		private var _field:TextField = new TextField();

		public function LoadedAvm1Keys()
		{
			addChild(_loader);
			_field.name = "as3field";
			_field.type = TextFieldType.INPUT;
			_field.border = true;
			_field.x = 10;
			_field.y = 110;
			_field.width = 150;
			_field.height = 25;
			_field.addEventListener(Event.CHANGE, changed);
			addChild(_field);
			var types:Array = ["keyDown", "keyUp", "textInput", "focusIn", "focusOut", "keyFocusChange", "mouseFocusChange"];
			for (var i:int = 0; i < types.length; i++)
			{
				stage.addEventListener(types[i], heard, true);
				stage.addEventListener(types[i], atStage);
			}

			_loader.load(new URLRequest("keys.swf"));
		}

		private function changed(e:Event):void
		{
			trace("as3:change as3field=" + _field.text);
		}

		private function nameOf(o:Object):String
		{
			if (o == null)
			{
				return "null";
			}

			return o == stage ? "stage" : o.name;
		}

		private function atStage(e:Event):void
		{
			if (e.eventPhase == EventPhase.AT_TARGET)
			{
				heard(e);
			}
		}

		private function heard(e:Event):void
		{
			var extra:String = "";
			if (e is KeyboardEvent)
			{
				extra = " code " + KeyboardEvent(e).keyCode;
			}

			if (e is TextEvent)
			{
				extra = " text " + TextEvent(e).text;
			}

			if (e is FocusEvent)
			{
				extra = " related " + nameOf(FocusEvent(e).relatedObject);
			}

			trace("as3:" + e.type + " " + nameOf(e.target) + extra + " focus " + nameOf(stage.focus));
		}
	}
}
