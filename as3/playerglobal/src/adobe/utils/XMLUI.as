// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package adobe.utils
{
	public final class XMLUI
	{
		public function XMLUI()
		{
		}

		public static native function getProperty(arg0:String):String;
		public static native function setProperty(arg0:String, arg1:String):void;
		public static native function accept():void;
		public static native function cancel():void;
	}
}
