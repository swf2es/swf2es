// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.automation
{
	import flash.display.BitmapData;
	import flash.events.EventDispatcher;
	import flash.geom.Rectangle;

	public class StageCapture extends EventDispatcher
	{
		public function StageCapture()
		{
		}

		public static const CURRENT:String = "current";
		public static const NEXT:String = "next";
		public static const MULTIPLE:String = "multiple";
		public static const RASTER:String = "raster";
		public static const STAGE:String = "stage";
		public static const SCREEN:String = "screen";
		public native function capture(arg0:String):void;
		public native function cancel():void;
		public native function set fileNameBase(arg0:String):void;
		public native function get fileNameBase():String;
		public native function set clipRect(arg0:Rectangle):void;
		public native function get clipRect():Rectangle;
		public native function captureBitmapData():BitmapData;
		public native function set captureSource(arg0:String):void;
		public native function get captureSource():String;
	}
}
