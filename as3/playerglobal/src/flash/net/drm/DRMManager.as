// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net.drm
{
	import flash.events.EventDispatcher;
	import flash.utils.ByteArray;

	[API("663", "667")]
	public class DRMManager extends EventDispatcher
	{
		public function DRMManager()
		{
		}

		public static native function getDRMManager():DRMManager;

		[API("667")]
		public static native function get isSupported():Boolean;

		public native function authenticate(arg0:String, arg1:String, arg2:String, arg3:String):void;

		public native function setAuthenticationToken(arg0:String, arg1:String, arg2:ByteArray):void;

		public native function loadVoucher(arg0:DRMContentData, arg1:String):void;

		[API("667")]
		public native function loadPreviewVoucher(arg0:DRMContentData):void;

		public native function resetDRMVouchers():void;
	}
}
