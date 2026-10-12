// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.data
{
	import flash.utils.ByteArray;

	[API("661")]
	public class EncryptedLocalStore
	{
		public function EncryptedLocalStore()
		{
		}

		public static native function setItem(arg0:String, arg1:ByteArray, arg2:Boolean = false):void;

		public static native function getItem(arg0:String):ByteArray;

		public static native function removeItem(arg0:String):void;

		public static native function reset():void;

		[API("668")]
		public static native function get isSupported():Boolean;
	}
}
