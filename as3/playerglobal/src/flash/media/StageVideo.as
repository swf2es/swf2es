// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.media
{
	import flash.events.EventDispatcher;
	import flash.geom.Point;
	import flash.geom.Rectangle;
	import flash.net.NetStream;

	[API("667")]
	public class StageVideo extends EventDispatcher
	{
		public function StageVideo()
		{
		}

		public native function attachNetStream(arg0:NetStream):void;

		[API("682")]
		public native function attachCamera(arg0:Camera):void;

		public native function get viewPort():Rectangle;

		public native function set viewPort(arg0:Rectangle):void;

		public native function set pan(arg0:Point):void;

		public native function get pan():Point;

		public native function set zoom(arg0:Point):void;

		public native function get zoom():Point;

		public native function set depth(arg0:int):void;

		public native function get depth():int;

		public native function get videoWidth():int;

		public native function get videoHeight():int;

		public native function get colorSpaces():Vector.<String>;
	}
}
