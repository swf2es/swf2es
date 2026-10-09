// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.text.engine
{
	[API("662")]
	public final class ElementFormat
	{
		public function ElementFormat(fontDescription:FontDescription = null, fontSize:Number = 12, color:uint = 0, alpha:Number = 1, textRotation:String = "auto", dominantBaseline:String = "roman", alignmentBaseline:String = "useDominantBaseline", baselineShift:Number = 0, kerning:String = "on", trackingRight:Number = 0, trackingLeft:Number = 0, locale:String = "en", breakOpportunity:String = "auto", digitCase:String = "default", digitWidth:String = "default", ligatureLevel:String = "common", typographicCase:String = "default")
		{
		}

		public native function get alignmentBaseline():String;

		public native function set alignmentBaseline(value:String):void;

		public native function get alpha():Number;

		public native function set alpha(value:Number):void;

		public native function get baselineShift():Number;

		public native function set baselineShift(value:Number):void;

		public native function get breakOpportunity():String;

		public native function set breakOpportunity(value:String):void;

		public native function get color():uint;

		public native function set color(value:uint):void;

		public native function get dominantBaseline():String;

		public native function set dominantBaseline(value:String):void;

		public native function get fontDescription():FontDescription;

		public native function set fontDescription(value:FontDescription):void;

		public native function get digitCase():String;

		public native function set digitCase(value:String):void;

		public native function get digitWidth():String;

		public native function set digitWidth(value:String):void;

		public native function get ligatureLevel():String;

		public native function set ligatureLevel(value:String):void;

		public native function get fontSize():Number;

		public native function set fontSize(value:Number):void;

		public native function get kerning():String;

		public native function set kerning(value:String):void;

		public native function get locale():String;

		public native function set locale(value:String):void;

		public native function get textRotation():String;

		public native function set textRotation(value:String):void;

		public native function get trackingRight():Number;

		public native function set trackingRight(value:Number):void;

		public native function get trackingLeft():Number;

		public native function set trackingLeft(value:Number):void;

		public native function get typographicCase():String;

		public native function set typographicCase(value:String):void;

		public native function get locked():Boolean;

		public native function set locked(value:Boolean):void;

		public native function getFontMetrics():FontMetrics;

		public native function clone():ElementFormat;
	}
}
