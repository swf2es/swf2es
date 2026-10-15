// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/KeyboardEvent.ts. Its
// fields are AS3's; only a redraw needs the player.

package flash.events
{
	public class KeyboardEvent extends Event
	{
		private var _charCode:uint;
		private var _keyCode:uint;
		private var _keyLocation:uint;
		private var _ctrlKey:Boolean;
		private var _altKey:Boolean;
		private var _shiftKey:Boolean;
		private var _controlKey:Boolean;
		private var _commandKey:Boolean;

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

		public function get charCode():uint
		{
			return _charCode;
		}

		public function set charCode(value:uint):void
		{
			_charCode = value;
		}

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

		public function get ctrlKey():Boolean
		{
			return _ctrlKey;
		}

		public function set ctrlKey(value:Boolean):void
		{
			_ctrlKey = value;
		}

		public function get altKey():Boolean
		{
			return _altKey;
		}

		public function set altKey(value:Boolean):void
		{
			_altKey = value;
		}

		public function get shiftKey():Boolean
		{
			return _shiftKey;
		}

		public function set shiftKey(value:Boolean):void
		{
			_shiftKey = value;
		}

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
		public function get commandKey():Boolean
		{
			return _commandKey;
		}

		[API("661")]
		public function set commandKey(value:Boolean):void
		{
			_commandKey = value;
		}
	}
}
