// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.text.engine
{
	[API("662")]
	public final class EastAsianJustifier extends TextJustifier
	{
		public function EastAsianJustifier(locale:String = "ja", lineJustification:String = "allButLast", justificationStyle:String = "pushInKinsoku")
		{
			super(locale, lineJustification);
		}

		public native function get justificationStyle():String;
		public native function set justificationStyle(value:String):void;
		[API("674")]
		public native function get composeTrailingIdeographicSpaces():Boolean;
		[API("674")]
		public native function set composeTrailingIdeographicSpaces(value:Boolean):void;
		override public native function clone():TextJustifier;
	}
}
