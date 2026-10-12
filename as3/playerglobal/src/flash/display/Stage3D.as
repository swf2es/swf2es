// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/display/Stage3D.ts.

package flash.display
{
	import flash.display3D.Context3D;
	import flash.events.EventDispatcher;

	[API("674")]
	public class Stage3D extends EventDispatcher
	{
		public function Stage3D()
		{
		}

		public native function get context3D():Context3D;

		public native function requestContext3D(context3DRenderMode:String = "auto", profile:String = "baseline"):void;

		[API("692")]
		public native function requestContext3DMatchingProfiles(profiles:Vector.<String>):void;

		public native function get x():Number;

		public native function set x(value:Number):void;

		public native function get y():Number;

		public native function set y(value:Number):void;

		public native function get visible():Boolean;

		public native function set visible(value:Boolean):void;
	}
}
