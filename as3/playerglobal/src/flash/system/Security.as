// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/system/Security.ts.

package flash.system
{
	public final class Security
	{
		public function Security()
		{
		}

		public static native function allowDomain(...domains):void;
		public static native function allowInsecureDomain(...domains):void;
		public static native function loadPolicyFile(url:String):void;
		public static native function get exactSettings():Boolean;
		public static native function set exactSettings(arg0:Boolean):void;
		public static native function get disableAVM1Loading():Boolean;
		public static native function set disableAVM1Loading(arg0:Boolean):void;
		public static native function showSettings(panel:String = "default"):void;
		public static native function get sandboxType():String;
		public static const REMOTE:String = "remote";
		public static const LOCAL_WITH_FILE:String = "localWithFile";
		public static const LOCAL_WITH_NETWORK:String = "localWithNetwork";
		public static const LOCAL_TRUSTED:String = "localTrusted";
		[API("661")]
		public static const APPLICATION:String = "application";
		[API("672")]
		public static native function get pageDomain():String;
	}
}
