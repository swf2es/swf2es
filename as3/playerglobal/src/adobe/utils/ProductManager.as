// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package adobe.utils
{
	import flash.events.EventDispatcher;

	public final class ProductManager extends EventDispatcher
	{
		public function ProductManager(arg0:String = null, arg1:Boolean = false)
		{
		}

		[API("692")]
		public static native function get isAllowed():Boolean;

		public native function get running():Boolean;

		public native function get installed():Boolean;

		public native function launch(arg0:String = null):Boolean;

		public native function get installedVersion():String;

		public native function download(arg0:String = null, arg1:String = null, arg2:Array = null):Boolean;

		public native function doSelfUpgrade(arg0:String):Boolean;
	}
}
