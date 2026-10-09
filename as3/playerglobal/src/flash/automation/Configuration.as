// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.automation
{
	public class Configuration
	{
		public function Configuration()
		{
		}

		public static native function get testAutomationConfiguration():String;
		public static native function set deviceConfiguration(arg0:String):void;
		public static native function get deviceConfiguration():String;
	}
}
