// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/GestureEvent.ts.

package flash.events
{
	[API("667")]
	public class GestureEvent extends Event
	{
		private var _phase:String;
		private var _ctrlKey:Boolean;
		private var _altKey:Boolean;
		private var _shiftKey:Boolean;
		private var _commandKey:Boolean;
		private var _controlKey:Boolean;

		public function GestureEvent(type:String, bubbles:Boolean = true, cancelable:Boolean = false, phase:String = null, localX:Number = 0, localY:Number = 0, ctrlKey:Boolean = false, altKey:Boolean = false, shiftKey:Boolean = false, commandKey:Boolean = false, controlKey:Boolean = false)
		{
			super(type, bubbles, cancelable);
			this.phase = phase;
			this.localX = localX;
			this.localY = localY;
			this.ctrlKey = ctrlKey;
			this.altKey = altKey;
			this.shiftKey = shiftKey;
			this.commandKey = commandKey;
			this.controlKey = controlKey;
		}

		public static const GESTURE_TWO_FINGER_TAP:String = "gestureTwoFingerTap";

		override public function clone():Event
		{
			return new GestureEvent(type, bubbles, cancelable, phase, localX, localY, ctrlKey, altKey, shiftKey, commandKey, controlKey);
		}

		override public function toString():String
		{
			return formatToString("GestureEvent", "type", "bubbles", "cancelable", "phase", "localX", "localY", "stageX", "stageY", "ctrlKey", "altKey", "shiftKey", "commandKey", "controlKey");
		}

		public native function get localX():Number;

		public native function set localX(value:Number):void;

		public native function get localY():Number;

		public native function set localY(value:Number):void;

		public function get phase():String
		{
			return _phase;
		}

		public function set phase(value:String):void
		{
			_phase = value;
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

		public function get stageX():Number
		{
			return getStageX();
		}

		public function get stageY():Number
		{
			return getStageY();
		}

		public native function updateAfterEvent():void;

		public function get commandKey():Boolean
		{
			return _commandKey;
		}

		public function set commandKey(value:Boolean):void
		{
			_commandKey = value;
		}

		public function get controlKey():Boolean
		{
			return _controlKey;
		}

		public function set controlKey(value:Boolean):void
		{
			_controlKey = value;
		}

		// The player's natives (packages/player/src/playerglobal/flash/events/GestureEvent.ts).
		private native function getStageX():Number;

		private native function getStageY():Number;
	}
}
