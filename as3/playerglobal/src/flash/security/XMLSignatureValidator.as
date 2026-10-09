// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.security
{
	import flash.events.EventDispatcher;
	import flash.utils.ByteArray;

	public class XMLSignatureValidator extends EventDispatcher
	{
		public function XMLSignatureValidator()
		{
		}

		[API("668")]
		public static native function get isSupported():Boolean;
		public native function set uriDereferencer(arg0:IURIDereferencer):void;
		public native function get uriDereferencer():IURIDereferencer;
		public native function addCertificate(arg0:ByteArray, arg1:Boolean):*;
		public native function set useSystemTrustStore(arg0:Boolean):void;
		public native function get useSystemTrustStore():Boolean;
		public native function set revocationCheckSetting(arg0:String):void;
		public native function get revocationCheckSetting():String;
		[API("663")]
		public native function set referencesValidationSetting(arg0:String):void;
		[API("663")]
		public native function get referencesValidationSetting():String;
		public native function get referencesStatus():String;
		public native function get digestStatus():String;
		public native function get identityStatus():String;
		public native function get validityStatus():String;
		public native function get signerTrustSettings():Array;
		public native function get signerExtendedKeyUsages():Array;
		public native function verify(arg0:XML):void;
		public native function get signerCN():String;
		public native function get signerDN():String;
	}
}
