// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/PressAndTapGestureEvent.ts.

package flash.events
{
	[API("667")]
	public class PressAndTapGestureEvent extends GestureEvent
	{
		public function PressAndTapGestureEvent(type:String, bubbles:Boolean = true, cancelable:Boolean = false, phase:String = null, localX:Number = 0, localY:Number = 0, tapLocalX:Number = 0, tapLocalY:Number = 0, ctrlKey:Boolean = false, altKey:Boolean = false, shiftKey:Boolean = false, commandKey:Boolean = false, controlKey:Boolean = false)
		{
			super(type, bubbles, cancelable, phase, localX, localY);
			this.tapLocalX = tapLocalX;
			this.tapLocalY = tapLocalY;
			this.ctrlKey = ctrlKey;
			this.altKey = altKey;
			this.shiftKey = shiftKey;
			this.commandKey = commandKey;
			this.controlKey = controlKey;
		}

		public static const GESTURE_PRESS_AND_TAP:String = "gesturePressAndTap";

		override public function clone():Event
		{
			return new PressAndTapGestureEvent(type, bubbles, cancelable, phase, localX, localY, tapLocalX, tapLocalY, ctrlKey, altKey, shiftKey, commandKey, controlKey);
		}

		override public function toString():String
		{
			return formatToString("PressAndTapGestureEvent", "type", "bubbles", "cancelable", "phase", "localX", "localY", "tapLocalX", "tapLocalY", "ctrlKey", "altKey", "shiftKey", "commandKey", "controlKey");
		}

		public native function get tapLocalX():Number;

		public native function set tapLocalX(value:Number):void;

		public native function get tapLocalY():Number;

		public native function set tapLocalY(value:Number):void;

		public function get tapStageX():Number
		{
			return getTapStageX();
		}

		public function get tapStageY():Number
		{
			return getTapStageY();
		}

		// The player's natives (packages/player/src/playerglobal/flash/events/PressAndTapGestureEvent.ts).
		private native function getTapStageX():Number;

		private native function getTapStageY():Number;
	}
}
