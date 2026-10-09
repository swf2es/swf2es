// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/text/Font.ts.

package flash.text
{
	public class Font
	{
		public function Font()
		{
		}

		public static native function enumerateFonts(enumerateDeviceFonts:Boolean = false):Array;
		public static native function registerFont(font:Class):void;
		public native function get fontName():String;
		public native function get fontStyle():String;
		public native function get fontType():String;
		public native function hasGlyphs(str:String):Boolean;
	}
}
