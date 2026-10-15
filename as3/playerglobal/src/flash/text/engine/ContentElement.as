// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.text.engine
{
	import flash.events.EventDispatcher;

	[API("662")]
	public class ContentElement
	{
		public function ContentElement(elementFormat:ElementFormat = null, eventMirror:EventDispatcher = null, textRotation:String = "rotate0")
		{
		}

		public static const GRAPHIC_ELEMENT:uint = 65007;
		public var userData:*;

		public native function get textBlock():TextBlock;

		public native function get textBlockBeginIndex():int;

		public native function get elementFormat():ElementFormat;

		public native function set elementFormat(value:ElementFormat):void;

		public native function get eventMirror():EventDispatcher;

		public native function set eventMirror(eventMirror:EventDispatcher):void;

		public native function get groupElement():GroupElement;

		public native function get rawText():String;

		public native function get text():String;

		public native function get textRotation():String;

		public native function set textRotation(textRotation:String):void;
	}
}
