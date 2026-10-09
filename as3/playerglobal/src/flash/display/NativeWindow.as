// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.display
{
	import flash.events.EventDispatcher;
	import flash.geom.Point;
	import flash.geom.Rectangle;

	public class NativeWindow extends EventDispatcher
	{
		public function NativeWindow(initOptions:NativeWindowInitOptions)
		{
		}

		[API("668")]
		public static native function get isSupported():Boolean;
		public static native function get supportsMenu():Boolean;
		public static native function get supportsNotification():Boolean;
		public static native function get supportsTransparency():Boolean;
		public static native function get systemMinSize():Point;
		public static native function get systemMaxSize():Point;
		public native function get stage():Stage;
		public native function set title(arg0:String):void;
		public native function get title():String;
		public native function set bounds(value:Rectangle):void;
		public native function get bounds():Rectangle;
		public native function get displayState():String;
		public native function minimize():void;
		public native function maximize():void;
		public native function restore():void;
		public native function close():void;
		public native function get closed():Boolean;
		public native function get visible():Boolean;
		public native function set visible(arg0:Boolean):void;
		public native function get systemChrome():String;
		public native function get transparent():Boolean;
		public native function get type():String;
		public native function get minimizable():Boolean;
		public native function get maximizable():Boolean;
		public native function get resizable():Boolean;
		public native function startMove():Boolean;
		public native function startResize(edgeOrCorner:String = "BR"):Boolean;
		public native function get minSize():Point;
		public native function set minSize(arg0:Point):void;
		public native function get maxSize():Point;
		public native function set maxSize(arg0:Point):void;
		public native function orderToFront():Boolean;
		public native function orderToBack():Boolean;
		public native function orderInFrontOf(window:NativeWindow):Boolean;
		public native function orderInBackOf(window:NativeWindow):Boolean;
		public native function get alwaysInFront():Boolean;
		public native function set alwaysInFront(arg0:Boolean):void;
		public native function get active():Boolean;
		public native function activate():void;
		public native function globalToScreen(globalPoint:Point):Point;
		public native function get menu():NativeMenu;
		public native function set menu(arg0:NativeMenu):void;
		public native function get width():Number;
		public native function set width(value:Number):void;
		public native function get height():Number;
		public native function set height(value:Number):void;
		public native function get x():Number;
		public native function set x(value:Number):void;
		public native function notifyUser(type:String):void;
		public native function get y():Number;
		public native function set y(value:Number):void;
	}
}
