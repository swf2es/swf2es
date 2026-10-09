// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/text/engine/FontDescription.ts.

package flash.text.engine
{
	[API("662")]
	public final class FontDescription
	{
		public function FontDescription(fontName:String = "_serif", fontWeight:String = "normal", fontPosture:String = "normal", fontLookup:String = "device", renderingMode:String = "cff", cffHinting:String = "horizontalStem")
		{
			this.fontName = fontName;
			this.fontWeight = fontWeight;
			this.fontPosture = fontPosture;
			this.fontLookup = fontLookup;
			this.renderingMode = renderingMode;
			this.cffHinting = cffHinting;
		}

		public static native function isFontCompatible(fontName:String, fontWeight:String, fontPosture:String):Boolean;

		[API("667")]
		public static native function isDeviceFontCompatible(arg0:String, arg1:String, arg2:String):Boolean;

		public native function get renderingMode():String;

		public native function set renderingMode(value:String):void;

		public native function get fontLookup():String;

		public native function set fontLookup(value:String):void;

		public native function get fontName():String;

		public native function set fontName(value:String):void;

		public native function get fontPosture():String;

		public native function set fontPosture(value:String):void;

		public native function get fontWeight():String;

		public native function set fontWeight(value:String):void;

		public native function get cffHinting():String;

		public native function set cffHinting(value:String):void;

		public native function get locked():Boolean;

		public native function set locked(value:Boolean):void;

		public native function clone():FontDescription;
	}
}
