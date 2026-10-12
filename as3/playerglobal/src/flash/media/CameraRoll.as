// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.media
{
	import flash.display.BitmapData;
	import flash.events.EventDispatcher;

	[API("668")]
	public class CameraRoll extends EventDispatcher
	{
		public function CameraRoll()
		{
		}

		public static native function get supportsAddBitmapData():Boolean;

		[API("669")]
		public static native function get supportsBrowseForImage():Boolean;

		public native function addBitmapData(arg0:BitmapData):void;

		[API("669")]
		public native function browseForImage(arg0:CameraRollBrowseOptions = null):void;
	}
}
