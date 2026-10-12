// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.text.engine
{
	import flash.events.EventDispatcher;

	[API("662")]
	public final class TextElement extends ContentElement
	{
		public function TextElement(text:String = null, elementFormat:ElementFormat = null, eventMirror:EventDispatcher = null, textRotation:String = "rotate0")
		{
		}

		public native function set text(value:String):void;

		public native function replaceText(beginIndex:int, endIndex:int, newText:String):void;
	}
}
