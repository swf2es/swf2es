// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/text/StyleSheet.ts.

package flash.text
{
	import flash.events.EventDispatcher;

	public dynamic class StyleSheet extends EventDispatcher
	{
		public function StyleSheet()
		{
		}

		public native function getStyle(styleName:String):Object;

		public native function setStyle(styleName:String, styleObject:Object):void;

		public native function clear():void;

		public native function get styleNames():Array;

		public native function transform(formatObject:Object):TextFormat;

		public native function parseCSS(CSSText:String):void;
	}
}
