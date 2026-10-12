// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.text
{
	public class TextFormat
	{
		public function TextFormat(font:String = null, size:Object = null, color:Object = null, bold:Object = null, italic:Object = null, underline:Object = null, url:String = null, target:String = null, align:String = null, leftMargin:Object = null, rightMargin:Object = null, indent:Object = null, leading:Object = null)
		{
			this.font = font;
			this.size = size;
			this.color = color;
			this.bold = bold;
			this.italic = italic;
			this.underline = underline;
			this.url = url;
			this.target = target;
			this.align = align;
			this.leftMargin = leftMargin;
			this.rightMargin = rightMargin;
			this.indent = indent;
			this.leading = leading;
		}

		public native function get align():String;

		public native function set align(param1:String):void;

		public native function get blockIndent():Object;

		public native function set blockIndent(param1:Object):void;

		public native function get bold():Object;

		public native function set bold(param1:Object):void;

		public native function get bullet():Object;

		public native function set bullet(param1:Object):void;

		public native function get color():Object;

		public native function set color(param1:Object):void;

		public native function get display():String;

		public native function set display(param1:String):void;

		public native function get font():String;

		public native function set font(param1:String):void;

		public native function get indent():Object;

		public native function set indent(param1:Object):void;

		public native function get italic():Object;

		public native function set italic(param1:Object):void;

		public native function get kerning():Object;

		public native function set kerning(param1:Object):void;

		public native function get leading():Object;

		public native function set leading(param1:Object):void;

		public native function get leftMargin():Object;

		public native function set leftMargin(param1:Object):void;

		public native function get letterSpacing():Object;

		public native function set letterSpacing(param1:Object):void;

		public native function get rightMargin():Object;

		public native function set rightMargin(param1:Object):void;

		public native function get size():Object;

		public native function set size(param1:Object):void;

		public native function get tabStops():Array;

		public native function set tabStops(param1:Array):void;

		public native function get target():String;

		public native function set target(param1:String):void;

		public native function get underline():Object;

		public native function set underline(param1:Object):void;

		public native function get url():String;

		public native function set url(param1:String):void;
	}
}
