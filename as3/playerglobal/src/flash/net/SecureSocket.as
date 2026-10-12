// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.net
{
	import flash.security.X509Certificate;
	import flash.utils.ByteArray;

	public class SecureSocket extends Socket
	{
		public function SecureSocket()
		{
		}

		[API("674", "668")]
		public static native function get isSupported():Boolean;

		[API("674", "668")]
		override public native function connect(arg0:String, arg1:int):void;

		[API("674", "668")]
		public native function get serverCertificateStatus():String;

		[API("674")]
		public native function get serverCertificate():X509Certificate;

		[API("674")]
		public native function addBinaryChainBuildingCertificate(arg0:ByteArray, arg1:Boolean):void;
	}
}
