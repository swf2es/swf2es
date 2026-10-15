// A tag XMLParser read, internal to flash.xml; natives in
// packages/player/src/playerglobal/flash/xml/XMLDocument.ts.

package flash.xml
{
	internal final class XMLTag
	{
		public native function get type():uint;

		public native function set type(value:uint):void;

		public native function get empty():Boolean;

		public native function set empty(value:Boolean):void;

		// An element's name, "/" first for an end tag, or the text of any other tag.
		public native function get value():String;

		public native function set value(value:String):void;

		public native function get attrs():Object;

		public native function set attrs(value:Object):void;
	}
}
