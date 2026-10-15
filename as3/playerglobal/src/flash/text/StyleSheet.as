// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts);
// natives in packages/player/src/playerglobal/flash/text/StyleSheet.ts. The
// styles and their TextFormats from Ruffle's (https://github.com/ruffle-rs/ruffle),
// core/src/avm2/globals/flash/text/StyleSheet.as: MIT OR Apache-2.0, Copyright (c)
// 2018-2022 Ruffle LLC and Ruffle contributors.

package flash.text
{
	import flash.events.EventDispatcher;

	public dynamic class StyleSheet extends EventDispatcher
	{
		// Copies of the style objects as given, by lower-cased selector, for getStyle.
		private var _styleObjects:Object = {};

		public function StyleSheet()
		{
			// Their TextFormats, which the player's fields read.
			_styles = {};
		}

		public function getStyle(styleName:String):Object
		{
			return copy(_styleObjects[styleName.toLowerCase()]);
		}

		public function setStyle(styleName:String, styleObject:Object):void
		{
			const key:String = styleName.toLowerCase();
			// Null too: an empty style, as Flash keeps one.
			_styleObjects[key] = copy(styleObject);
			const formats:Object = _styles;
			formats[key] = transform(copy(styleObject));
			_update();
		}

		public function clear():void
		{
			_styleObjects = {};
			_styles = {};
			_update();
		}

		public function get styleNames():Array
		{
			const names:Array = [];
			for (var name:String in _styleObjects)
			{
				names.push(name);
			}

			return names;
		}

		public function transform(formatObject:Object):TextFormat
		{
			if (!formatObject)
			{
				return null;
			}

			const format:TextFormat = new TextFormat();
			if (formatObject.color)
			{
				format.color = _parseColor(formatObject.color);
			}

			if (formatObject.display)
			{
				format.display = formatObject.display;
			}

			if (formatObject.fontFamily)
			{
				format.font = _parseCSSFontFamily(formatObject.fontFamily);
			}

			if (formatObject.fontSize)
			{
				const size:int = parseInt(formatObject.fontSize);
				if (size > 0)
				{
					format.size = size;
				}
			}

			if (formatObject.fontStyle == "italic")
			{
				format.italic = true;
			}
			else if (formatObject.fontStyle == "normal")
			{
				format.italic = false;
			}

			if (formatObject.fontWeight == "bold")
			{
				format.bold = true;
			}
			else if (formatObject.fontWeight == "normal")
			{
				format.bold = false;
			}

			if (formatObject.kerning == "true")
			{
				format.kerning = true;
			}
			else if (formatObject.kerning == "false")
			{
				format.kerning = false;
			}
			else
			{
				// Set whether it is given or not.
				format.kerning = parseInt(formatObject.kerning);
			}

			if (formatObject.leading)
			{
				format.leading = parseInt(formatObject.leading);
			}

			if (formatObject.letterSpacing)
			{
				format.letterSpacing = parseFloat(formatObject.letterSpacing);
			}

			if (formatObject.marginLeft)
			{
				format.leftMargin = parseInt(formatObject.marginLeft);
			}

			if (formatObject.marginRight)
			{
				format.rightMargin = parseInt(formatObject.marginRight);
			}

			if (formatObject.textAlign)
			{
				format.align = formatObject.textAlign;
			}

			if (formatObject.textDecoration == "underline")
			{
				format.underline = true;
			}
			else if (formatObject.textDecoration == "none")
			{
				format.underline = false;
			}

			if (formatObject.textIndent)
			{
				format.indent = parseInt(formatObject.textIndent);
			}

			return format;
		}

		public function parseCSS(CSSText:String):void
		{
			// A sheet Flash rejects changes nothing, and throws nothing.
			const parsed:Object = _parseCSSInternal(CSSText);
			if (parsed == null)
			{
				return;
			}

			for (var selector:String in parsed)
			{
				setStyle(selector, parsed[selector]);
			}
		}

		private static function copy(original:Object):Object
		{
			const result:Object = {};
			for (var key:String in original)
			{
				result[key] = original[key];
			}

			return result;
		}

		// The player's natives (packages/player/src/playerglobal/flash/text/StyleSheet.ts).
		private native function get _styles():Object;

		private native function set _styles(value:Object):void;

		private native function _update():void;

		private native function _parseCSSInternal(css:String):Object;

		private native function _parseCSSFontFamily(family:String):String;

		private native function _parseColor(color:String):uint;
	}
}
