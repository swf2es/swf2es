// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/geom/PerspectiveProjection.ts.

package flash.geom
{
	[API("662")]
	public class PerspectiveProjection
	{
		public function PerspectiveProjection()
		{
			ctor();
		}

		// The player's native constructor.
		private native function ctor():void;

		public native function get fieldOfView():Number;
		public native function set fieldOfView(value:Number):void;
		public native function get projectionCenter():Point;
		public native function set projectionCenter(value:Point):*;
		public native function get focalLength():Number;
		public native function set focalLength(value:Number):void;
		public native function toMatrix3D():Matrix3D;
	}
}
