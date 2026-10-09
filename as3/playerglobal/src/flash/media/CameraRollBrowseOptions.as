// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.media
{
	import flash.geom.Rectangle;

	[API("675")]
	public class CameraRollBrowseOptions
	{
		public function CameraRollBrowseOptions()
		{
		}

		public native function get width():Number;

		public native function set width(arg0:Number):void;

		public native function get height():Number;

		public native function set height(arg0:Number):void;

		public native function get origin():Rectangle;

		public native function set origin(arg0:Rectangle):void;
	}
}
