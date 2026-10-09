// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/TouchEvent.ts.

package flash.events
{
	import flash.display.InteractiveObject;
	import flash.utils.ByteArray;

	[API("667")]
	public class TouchEvent extends Event
	{
		public function TouchEvent(type:String, bubbles:Boolean = true, cancelable:Boolean = false, touchPointID:int = 0, isPrimaryTouchPoint:Boolean = false, localX:Number = NaN, localY:Number = NaN, sizeX:Number = NaN, sizeY:Number = NaN, pressure:Number = NaN, relatedObject:InteractiveObject = null, ctrlKey:Boolean = false, altKey:Boolean = false, shiftKey:Boolean = false, arg14:Boolean = false, arg15:Boolean = false, arg16:Number = NaN, arg17:String = "unknown", arg18:ByteArray = null, arg19:Boolean = false)
		{
			super(type, bubbles, cancelable);
			this.localX = localX;
			this.localY = localY;
		}

		public static const TOUCH_BEGIN:String = "touchBegin";
		public static const TOUCH_END:String = "touchEnd";
		public static const TOUCH_MOVE:String = "touchMove";
		public static const TOUCH_OVER:String = "touchOver";
		public static const TOUCH_OUT:String = "touchOut";
		public static const TOUCH_ROLL_OVER:String = "touchRollOver";
		public static const TOUCH_ROLL_OUT:String = "touchRollOut";
		public static const TOUCH_TAP:String = "touchTap";
		public static const PROXIMITY_BEGIN:String = "proximityBegin";
		public static const PROXIMITY_END:String = "proximityEnd";
		public static const PROXIMITY_MOVE:String = "proximityMove";
		public static const PROXIMITY_OUT:String = "proximityOut";
		public static const PROXIMITY_OVER:String = "proximityOver";
		public static const PROXIMITY_ROLL_OUT:String = "proximityRollOut";
		public static const PROXIMITY_ROLL_OVER:String = "proximityRollOver";

		override public native function clone():Event;

		override public native function toString():String;

		public native function get localX():Number;

		public native function set localX(value:Number):void;

		public native function get localY():Number;

		public native function set localY(value:Number):void;

		public native function get touchPointID():int;

		public native function set touchPointID(value:int):void;

		public native function get isPrimaryTouchPoint():Boolean;

		public native function set isPrimaryTouchPoint(value:Boolean):void;

		public native function get sizeX():Number;

		public native function set sizeX(value:Number):void;

		public native function get sizeY():Number;

		public native function set sizeY(value:Number):void;

		public native function get pressure():Number;

		public native function set pressure(value:Number):void;

		public native function get relatedObject():InteractiveObject;

		public native function set relatedObject(value:InteractiveObject):void;

		public native function get ctrlKey():Boolean;

		public native function set ctrlKey(value:Boolean):void;

		public native function get altKey():Boolean;

		public native function set altKey(value:Boolean):void;

		public native function get shiftKey():Boolean;

		public native function set shiftKey(value:Boolean):void;

		public native function get stageX():Number;

		public native function get stageY():Number;

		public native function updateAfterEvent():void;

		public native function get isRelatedObjectInaccessible():Boolean;

		public native function set isRelatedObjectInaccessible(value:Boolean):void;

		public native function get commandKey():Boolean;

		public native function set commandKey(arg0:Boolean):void;

		public native function get controlKey():Boolean;

		public native function set controlKey(arg0:Boolean):void;

		[API("675")]
		public native function isToolButtonDown(index:int):Boolean;

		[API("675")]
		public native function get timestamp():Number;

		[API("675")]
		public native function set timestamp(arg0:Number):void;

		[API("675")]
		public native function get touchIntent():String;

		[API("675")]
		public native function set touchIntent(arg0:String):void;

		[API("675")]
		public native function get isTouchPointCanceled():Boolean;

		[API("675")]
		public native function set isTouchPointCanceled(arg0:Boolean):void;

		[API("675")]
		public native function getSamples(buffer:ByteArray, append:Boolean = false):uint;

		// The player's natives (packages/player/src/playerglobal/flash/events/TouchEvent.ts).
		private native function getStageX():Number;

		private native function getStageY():Number;

		private native function privateGetSamples(arg0:ByteArray):uint;

		private native function setSamples(arg0:ByteArray):void;
	}
}
