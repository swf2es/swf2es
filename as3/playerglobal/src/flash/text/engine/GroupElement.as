// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.text.engine
{
	import flash.events.EventDispatcher;

	[API("662")]
	public final class GroupElement extends ContentElement
	{
		public function GroupElement(elements:Vector.<ContentElement> = null, elementFormat:ElementFormat = null, eventMirror:EventDispatcher = null, textRotation:String = "rotate0")
		{
		}

		public native function get elementCount():int;

		public native function getElementAt(index:int):ContentElement;

		public native function setElements(elements:Vector.<ContentElement>):void;

		public native function groupElements(arg0:int, arg1:int):GroupElement;

		public native function ungroupElements(arg0:int):void;

		public native function mergeTextElements(arg0:int, arg1:int):TextElement;

		public native function splitTextElement(elementIndex:int, splitIndex:int):TextElement;

		public native function replaceElements(beginIndex:int, endIndex:int, newElements:Vector.<ContentElement>):Vector.<ContentElement>;

		public native function getElementAtCharIndex(arg0:int):ContentElement;

		public native function getElementIndex(testElement:ContentElement):int;
	}
}
