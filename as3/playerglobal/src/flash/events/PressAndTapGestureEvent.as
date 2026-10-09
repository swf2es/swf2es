// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/PressAndTapGestureEvent.ts.

package flash.events
{
	[API("667")]
	public class PressAndTapGestureEvent extends GestureEvent
	{
		public function PressAndTapGestureEvent(type:String, bubbles:Boolean = true, cancelable:Boolean = false, phase:String = null, localX:Number = 0, localY:Number = 0, tapLocalX:Number = 0, tapLocalY:Number = 0, ctrlKey:Boolean = false, altKey:Boolean = false, shiftKey:Boolean = false, controlKey:Boolean = false, arg12:Boolean = false)
		{
			super(type);
		}

		public static const GESTURE_PRESS_AND_TAP:String = "gesturePressAndTap";
		override public native function clone():Event;
		override public native function toString():String;
		public native function get tapLocalX():Number;
		public native function set tapLocalX(value:Number):void;
		public native function get tapLocalY():Number;
		public native function set tapLocalY(value:Number):void;
		public native function get tapStageX():Number;
		public native function get tapStageY():Number;
	}
}
