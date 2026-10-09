// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/KeyboardEvent.ts.

package flash.events
{
	public class KeyboardEvent extends Event
	{
		public function KeyboardEvent(type:String, bubbles:Boolean = true, cancelable:Boolean = false, charCodeValue:uint = 0, keyCodeValue:uint = 0, keyLocationValue:uint = 0, ctrlKeyValue:Boolean = false, altKeyValue:Boolean = false, shiftKeyValue:Boolean = false, controlKeyValue:Boolean = false, commandKeyValue:Boolean = false)
		{
			super(type);
		}

		public static const KEY_DOWN:String = "keyDown";
		public static const KEY_UP:String = "keyUp";
		override public native function clone():Event;
		override public native function toString():String;
		public native function get charCode():uint;
		public native function set charCode(val:uint):void;
		public native function get keyCode():uint;
		public native function set keyCode(val:uint):void;
		public native function get keyLocation():uint;
		public native function set keyLocation(val:uint):void;
		public native function get ctrlKey():Boolean;
		public native function set ctrlKey(val:Boolean):void;
		public native function get altKey():Boolean;
		public native function set altKey(val:Boolean):void;
		public native function get shiftKey():Boolean;
		public native function set shiftKey(val:Boolean):void;
		public native function updateAfterEvent():void;
		[API("661")]
		public native function get controlKey():Boolean;
		[API("661")]
		public native function set controlKey(val:Boolean):void;
		[API("661")]
		public native function get commandKey():Boolean;
		[API("661")]
		public native function set commandKey(val:Boolean):void;
	}
}
