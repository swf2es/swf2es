// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.events
{
	public class TextEvent extends Event
	{
		public function TextEvent(type:String, bubbles:Boolean = false, cancelable:Boolean = false, text:String = "")
		{
			super(type);
		}

		public static const LINK:String = "link";
		public static const TEXT_INPUT:String = "textInput";

		public native function get text():String;

		public native function set text(value:String):void;

		override public native function clone():Event;

		override public native function toString():String;

		// The player's natives (packages/player/src/playerglobal/flash/events/TextEvent.ts).
		private native function copyNativeData(arg0:TextEvent):void;
	}
}
