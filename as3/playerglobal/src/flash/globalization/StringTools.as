// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/globalization/StringTools.ts.

package flash.globalization
{
	[API("667")]
	public final class StringTools
	{
		public function StringTools(requestedLocaleIDName:String)
		{
		}

		public static native function getAvailableLocaleIDNames():Vector.<String>;
		public native function get lastOperationStatus():String;
		public native function get requestedLocaleIDName():String;
		public native function get actualLocaleIDName():String;
		public native function toLowerCase(s:String):String;
		public native function toUpperCase(s:String):String;
	}
}
