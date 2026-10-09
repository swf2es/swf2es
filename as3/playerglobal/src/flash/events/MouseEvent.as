// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/events/MouseEvent.ts.

package flash.events
{
	import flash.display.InteractiveObject;

	public class MouseEvent extends Event
	{
		public function MouseEvent(type:String, bubbles:Boolean = true, cancelable:Boolean = false, localX:Number = void 0, localY:Number = void 0, relatedObject:InteractiveObject = null, ctrlKey:Boolean = false, altKey:Boolean = false, shiftKey:Boolean = false, buttonDown:Boolean = false, delta:int = 0, arg11:Boolean = false, arg12:Boolean = false, arg13:int = 0)
		{
			super(type);
		}

		public static const CLICK:String = "click";
		public static const DOUBLE_CLICK:String = "doubleClick";
		public static const MOUSE_DOWN:String = "mouseDown";
		public static const MOUSE_MOVE:String = "mouseMove";
		public static const MOUSE_OUT:String = "mouseOut";
		public static const MOUSE_OVER:String = "mouseOver";
		public static const MOUSE_UP:String = "mouseUp";
		public static const RELEASE_OUTSIDE:String = "releaseOutside";
		public static const MOUSE_WHEEL:String = "mouseWheel";
		public static const ROLL_OUT:String = "rollOut";
		public static const ROLL_OVER:String = "rollOver";
		public static const MIDDLE_CLICK:String = "middleClick";
		public static const MIDDLE_MOUSE_DOWN:String = "middleMouseDown";
		public static const MIDDLE_MOUSE_UP:String = "middleMouseUp";
		public static const RIGHT_CLICK:String = "rightClick";
		public static const RIGHT_MOUSE_DOWN:String = "rightMouseDown";
		public static const RIGHT_MOUSE_UP:String = "rightMouseUp";
		public static const CONTEXT_MENU:String = "contextMenu";

		override public native function clone():Event;

		override public native function toString():String;

		public native function get localX():Number;

		public native function set localX(value:Number):void;

		public native function get localY():Number;

		public native function set localY(value:Number):void;

		public native function get relatedObject():InteractiveObject;

		public native function set relatedObject(value:InteractiveObject):void;

		public native function get ctrlKey():Boolean;

		public native function set ctrlKey(value:Boolean):void;

		public native function get altKey():Boolean;

		public native function set altKey(value:Boolean):void;

		public native function get shiftKey():Boolean;

		public native function set shiftKey(value:Boolean):void;

		public native function get buttonDown():Boolean;

		public native function set buttonDown(value:Boolean):void;

		public native function get delta():int;

		public native function set delta(value:int):void;

		public native function get stageX():Number;

		public native function get stageY():Number;

		public native function updateAfterEvent():void;

		[API("662")]
		public native function get isRelatedObjectInaccessible():Boolean;

		[API("662")]
		public native function set isRelatedObjectInaccessible(value:Boolean):void;

		[API("678")]
		public native function get movementX():Number;

		[API("678")]
		public native function set movementX(value:Number):void;

		[API("678")]
		public native function get movementY():Number;

		[API("678")]
		public native function set movementY(value:Number):void;

		public native function get commandKey():Boolean;

		public native function set commandKey(arg0:Boolean):void;

		public native function get controlKey():Boolean;

		public native function set controlKey(arg0:Boolean):void;

		public native function get clickCount():int;

		// The player's natives (packages/player/src/playerglobal/flash/events/MouseEvent.ts).
		private native function getStageX():Number;

		private native function getStageY():Number;
	}
}
