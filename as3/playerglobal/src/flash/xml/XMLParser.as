// The XML tokenizer legacy XMLDocument parses with, internal to flash.xml;
// natives in packages/player/src/playerglobal/flash/xml/XMLDocument.ts.

package flash.xml
{
	internal final class XMLParser
	{
		public native function startParse(source:String, ignoreWhite:Boolean):void;

		// The next tag into `tag`: 0, -1 at the end, or an error's status.
		public native function getNext(tag:XMLTag):int;
	}
}
