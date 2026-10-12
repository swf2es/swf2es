// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.text.engine
{
	[API("662")]
	public class TextJustifier
	{
		public function TextJustifier(locale:String, lineJustification:String)
		{
		}

		public static native function getJustifierForLocale(arg0:String):TextJustifier;

		public native function get locale():String;

		public native function get lineJustification():String;

		public native function set lineJustification(value:String):void;

		public function clone():TextJustifier
		{
			return new TextJustifier(locale, lineJustification);
		}
	}
}
