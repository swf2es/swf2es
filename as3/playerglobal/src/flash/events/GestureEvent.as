// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/GestureEvent.ts.

package flash.events
{
	[API("667")]
	public class GestureEvent extends Event
	{
		public function GestureEvent(type:String, bubbles:Boolean = true, cancelable:Boolean = false, phase:String = null, localX:Number = 0, localY:Number = 0, ctrlKey:Boolean = false, altKey:Boolean = false, shiftKey:Boolean = false, commandKey:Boolean = false, controlKey:Boolean = false)
		{
			super(type);
		}

		public static const GESTURE_TWO_FINGER_TAP:String = "gestureTwoFingerTap";

		override public native function clone():Event;

		override public native function toString():String;

		public native function get localX():Number;

		public native function set localX(value:Number):void;

		public native function get localY():Number;

		public native function set localY(value:Number):void;

		public native function get phase():String;

		public native function set phase(value:String):void;

		public native function get ctrlKey():Boolean;

		public native function set ctrlKey(value:Boolean):void;

		public native function get altKey():Boolean;

		public native function set altKey(value:Boolean):void;

		public native function get shiftKey():Boolean;

		public native function set shiftKey(value:Boolean):void;

		public native function get stageX():Number;

		public native function get stageY():Number;

		public native function updateAfterEvent():void;

		public native function get commandKey():Boolean;

		public native function set commandKey(value:Boolean):void;

		public native function get controlKey():Boolean;

		public native function set controlKey(value:Boolean):void;
	}
}
