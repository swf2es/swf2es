// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.media
{
	import flash.display.BitmapData;
	import flash.display.Stage;
	import flash.events.EventDispatcher;
	import flash.geom.Rectangle;

	[API("669")]
	public final class StageWebView extends EventDispatcher
	{
		public function StageWebView(configuration:Boolean = false)
		{
		}

		public static native function get isSupported():Boolean;
		public native function loadURL(arg0:String):void;
		public native function loadString(arg0:String, arg1:String = "text/html"):void;
		public native function stop():void;
		public native function reload():void;
		public native function get isHistoryBackEnabled():Boolean;
		public native function historyBack():void;
		public native function get isHistoryForwardEnabled():Boolean;
		public native function historyForward():void;
		public native function get location():String;
		public native function get title():String;
		public native function get viewPort():Rectangle;
		public native function set viewPort(arg0:Rectangle):void;
		public native function get stage():Stage;
		public native function set stage(arg0:Stage):void;
		public native function dispose():void;
		public native function assignFocus(arg0:String = "none"):void;
		[API("671")]
		public native function drawViewPortToBitmapData(arg0:BitmapData):void;
	}
}
