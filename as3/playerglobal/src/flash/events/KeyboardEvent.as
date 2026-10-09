// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/KeyboardEvent.ts.

package flash.events
{
	public class KeyboardEvent extends Event
	{
		private var _keyCode:uint;
		private var _keyLocation:uint;
		private var _controlKey:Boolean;

		public function KeyboardEvent(type:String, bubbles:Boolean = true, cancelable:Boolean = false, charCodeValue:uint = 0, keyCodeValue:uint = 0, keyLocationValue:uint = 0, ctrlKeyValue:Boolean = false, altKeyValue:Boolean = false, shiftKeyValue:Boolean = false, controlKeyValue:Boolean = false, commandKeyValue:Boolean = false)
		{
			super(type, bubbles, cancelable);
			this.charCode = charCodeValue;
			this.keyCode = keyCodeValue;
			this.keyLocation = keyLocationValue;
			this.ctrlKey = ctrlKeyValue;
			this.altKey = altKeyValue;
			this.shiftKey = shiftKeyValue;
			this.controlKey = controlKeyValue;
			this.commandKey = commandKeyValue;
		}

		public static const KEY_DOWN:String = "keyDown";
		public static const KEY_UP:String = "keyUp";

		override public function clone():Event
		{
			return new KeyboardEvent(type, bubbles, cancelable, charCode, keyCode, keyLocation, ctrlKey, altKey, shiftKey, controlKey, commandKey);
		}

		override public function toString():String
		{
			return formatToString("KeyboardEvent", "type", "bubbles", "cancelable", "eventPhase", "charCode", "keyCode", "keyLocation", "ctrlKey", "altKey", "shiftKey");
		}

		public native function get charCode():uint;

		public native function set charCode(val:uint):void;

		public function get keyCode():uint
		{
			return _keyCode;
		}

		public function set keyCode(value:uint):void
		{
			_keyCode = value;
		}

		public function get keyLocation():uint
		{
			return _keyLocation;
		}

		public function set keyLocation(value:uint):void
		{
			_keyLocation = value;
		}

		public native function get ctrlKey():Boolean;

		public native function set ctrlKey(val:Boolean):void;

		public native function get altKey():Boolean;

		public native function set altKey(val:Boolean):void;

		public native function get shiftKey():Boolean;

		public native function set shiftKey(val:Boolean):void;

		public native function updateAfterEvent():void;

		[API("661")]
		public function get controlKey():Boolean
		{
			return _controlKey;
		}

		[API("661")]
		public function set controlKey(value:Boolean):void
		{
			_controlKey = value;
		}

		[API("661")]
		public native function get commandKey():Boolean;

		[API("661")]
		public native function set commandKey(val:Boolean):void;
	}
}
