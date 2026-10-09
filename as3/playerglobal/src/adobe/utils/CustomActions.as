// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package adobe.utils
{
	public final class CustomActions
	{
		public function CustomActions()
		{
		}

		public static native function installActions(arg0:String, arg1:String):void;
		public static native function uninstallActions(arg0:String):void;
		public static native function get actionsList():Array;
		public static native function getActions(arg0:String):String;
	}
}
