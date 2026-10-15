// From Ruffle (https://github.com/ruffle-rs/ruffle), core/src/avm2/globals/flash/xml/XMLDocument.as:
// MIT OR Apache-2.0, Copyright (c) 2018-2022 Ruffle LLC and Ruffle contributors.
// parseXML is ours: the tree built from the tags of the player's tokenizer, as
// Flash's legacy parser builds it.

package flash.xml
{

	import flash.xml.XMLNode;
	import flash.xml.XMLNodeType;

	public class XMLDocument extends XMLNode
	{
		public var docTypeDecl:Object = null;
		public var idMap:Object;
		public var ignoreWhite:Boolean = false;
		public var xmlDecl:Object = null;

		public function XMLDocument(input:String = null)
		{
			super(XMLNodeType.ELEMENT_NODE, "");

			this.idMap = {};
			this.nodeName = null;

			if (input != null)
			{
				parseXML(input);
			}
		}

		public function parseXML(source:String):void
		{
			clear();
			const parser:XMLParser = new XMLParser();
			const tag:XMLTag = new XMLTag();
			parser.startParse(source, ignoreWhite);
			var parent:XMLNode = this;
			for (var status:int = parser.getNext(tag); status != END; status = parser.getNext(tag))
			{
				if (status != OK)
				{
					Error.throwError(TypeError, errorOf(status));
				}

				switch (tag.type)
				{
					case XMLNodeType.ELEMENT_NODE:
						if (tag.value.charAt(0) == "/")
						{
							if (parent == this)
							{
								Error.throwError(Error, 2070);
							}

							if (parent.nodeName != tag.value.substr(1))
							{
								Error.throwError(TypeError, 1096);
							}

							parent = parent.parentNode;
							break;
						}

						const element:XMLNode = createElement(tag.value);
						const attributes:Object = tag.attrs;
						element.attributes = attributes;
						if (attributes != null && attributes.id != null)
						{
							idMap[attributes.id] = element;
						}

						parent.appendChild(element);
						if (!tag.empty)
						{
							parent = element;
						}

						break;
					case XMLNodeType.TEXT_NODE:
					case CDATA:
						parent.appendChild(createTextNode(tag.value));
						break;
					case XML_DECLARATION:
						xmlDecl = "<?" + tag.value + "?>";
						break;
					case DOCTYPE:
						docTypeDecl = tag.value;
						break;
				}
			}

			// An element left open.
			if (parent != this)
			{
				Error.throwError(TypeError, 1096);
			}
		}

		// The tokenizer's tags and statuses (packages/runtime/src/avm2/natives/xml/parser.ts).
		private static const CDATA:uint = 4;
		private static const DOCTYPE:uint = 10;
		private static const XML_DECLARATION:uint = 13;
		private static const OK:int = 0;
		private static const END:int = -1;

		// A status as the error E4X throws for it.
		private static function errorOf(status:int):int
		{
			switch (status)
			{
				case -2:
					return 1091;
				case -3:
					return 1092;
				case -4:
					return 1093;
				case -5:
					return 1094;
				case -8:
					return 1095;
				case -10:
					return 1097;
				default:
					return 1090;
			}
		}

		public function createElement(name:String):XMLNode
		{
			return new XMLNode(XMLNodeType.ELEMENT_NODE, name);
		}

		public function createTextNode(text:String):XMLNode
		{
			return new XMLNode(XMLNodeType.TEXT_NODE, text);
		}

		override public function toString():String
		{
			const declaration:String = xmlDecl != null ? String(xmlDecl) : "";
			const doctype:String = docTypeDecl != null ? String(docTypeDecl) : "";
			return declaration + doctype + super.toString();
		}
	}
}
