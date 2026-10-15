// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.html
{
	import flash.geom.Rectangle;

	public class HTMLHost
	{
		public function HTMLHost(arg0:Boolean = true)
		{
		}

		public native function get htmlLoader():HTMLLoader;

		public native function get windowRect():Rectangle;

		public native function set windowRect(arg0:Rectangle):void;

		public native function windowFocus():void;

		public native function windowBlur():void;

		public native function updateLocation(arg0:String):void;

		public native function updateStatus(arg0:String):void;

		public native function updateTitle(arg0:String):void;

		public native function createWindow(arg0:HTMLWindowCreateOptions):HTMLLoader;

		public native function windowClose():void;
	}
}
