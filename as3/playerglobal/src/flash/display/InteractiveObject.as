// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/InteractiveObject.ts.

package flash.display
{
	import flash.accessibility.AccessibilityImplementation;
	import flash.geom.Rectangle;

	public class InteractiveObject extends DisplayObject
	{
		public function InteractiveObject()
		{
		}

		public native function get tabEnabled():Boolean;
		public native function set tabEnabled(value:Boolean):void;
		public native function get tabIndex():int;
		public native function set tabIndex(index:int):void;
		public native function get focusRect():Object;
		public native function set focusRect(value:Object):void;
		public native function get mouseEnabled():Boolean;
		public native function set mouseEnabled(value:Boolean):void;
		public native function get doubleClickEnabled():Boolean;
		public native function set doubleClickEnabled(value:Boolean):void;
		public native function get accessibilityImplementation():AccessibilityImplementation;
		public native function set accessibilityImplementation(value:AccessibilityImplementation):void;
		[API("670")]
		public native function get softKeyboardInputAreaOfInterest():Rectangle;
		[API("670")]
		public native function set softKeyboardInputAreaOfInterest(value:Rectangle):void;
		[API("670")]
		public native function get needsSoftKeyboard():Boolean;
		[API("670")]
		public native function set needsSoftKeyboard(value:Boolean):void;
		[API("670")]
		public native function requestSoftKeyboard():Boolean;
		public native function get contextMenu():NativeMenu;
		public native function set contextMenu(cm:NativeMenu):void;
	}
}
