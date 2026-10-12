// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.media
{
	import flash.events.EventDispatcher;

	[API("669")]
	public class CameraUI extends EventDispatcher
	{
		public function CameraUI()
		{
		}

		public static native function get isSupported():Boolean;

		public native function launch(arg0:String):void;
	}
}
