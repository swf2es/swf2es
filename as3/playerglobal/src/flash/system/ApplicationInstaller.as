// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.system
{
	import flash.events.EventDispatcher;
	import flash.utils.ByteArray;

	[API("686")]
	public final class ApplicationInstaller extends EventDispatcher
	{
		public function ApplicationInstaller()
		{
		}

		public static native function stringsDigest(arg0:XML):String;

		public static native function iconDigest(arg0:ByteArray):String;

		public native function install(arg0:String = "install_with_shortcuts"):void;

		public native function get isInstalled():Boolean;
	}
}
