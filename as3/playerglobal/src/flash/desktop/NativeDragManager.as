// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.desktop
{
	import flash.display.BitmapData;
	import flash.display.InteractiveObject;
	import flash.geom.Point;

	[API("661")]
	public class NativeDragManager
	{
		public function NativeDragManager()
		{
		}

		public static native function get dropAction():String;
		public static native function set dropAction(arg0:String):void;
		public static native function acceptDragDrop(arg0:InteractiveObject):void;
		public static native function get isDragging():Boolean;
		public static native function get dragInitiator():InteractiveObject;
		public static native function doDrag(arg0:InteractiveObject, arg1:Clipboard, arg2:BitmapData = null, arg3:Point = null, arg4:NativeDragOptions = null):void;
		[API("668")]
		public static native function get isSupported():Boolean;
	}
}
