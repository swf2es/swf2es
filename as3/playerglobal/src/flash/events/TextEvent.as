// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	public class TextEvent extends Event
	{
		private var _text:String;

		public function TextEvent(type:String, bubbles:Boolean = false, cancelable:Boolean = false, text:String = "")
		{
			super(type, bubbles, cancelable);
			this.text = text;
		}

		public static const LINK:String = "link";
		public static const TEXT_INPUT:String = "textInput";

		public function get text():String
		{
			return _text;
		}

		public function set text(value:String):void
		{
			_text = value;
		}

		override public function clone():Event
		{
			const event:TextEvent = new TextEvent(type, bubbles, cancelable, text);
			copyNativeData(event);
			return event;
		}

		override public function toString():String
		{
			return formatToString("TextEvent", "type", "bubbles", "cancelable", "eventPhase", "text");
		}

		// The player's natives (packages/player/src/playerglobal/flash/events/TextEvent.ts).
		private native function copyNativeData(arg0:TextEvent):void;
	}
}
