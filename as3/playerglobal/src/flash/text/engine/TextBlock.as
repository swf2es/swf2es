// Its API as Flash Player's playerglobal declares it (tools/abc-surface/as3.ts).

package flash.text.engine
{
	[API("662")]
	public final class TextBlock
	{
		public function TextBlock(content:ContentElement = null, tabStops:Vector.<TabStop> = null, textJustifier:TextJustifier = null, lineRotation:String = "rotate0", baselineZero:String = "roman", bidiLevel:int = 0, applyNonLinearFontScaling:Boolean = true, baselineFontDescription:FontDescription = null, baselineFontSize:Number = 12)
		{
		}

		public var userData:*;
		public native function get applyNonLinearFontScaling():Boolean;
		public native function set applyNonLinearFontScaling(value:Boolean):void;
		public native function get baselineFontDescription():FontDescription;
		public native function set baselineFontDescription(value:FontDescription):void;
		public native function get baselineFontSize():Number;
		public native function set baselineFontSize(value:Number):void;
		public native function get baselineZero():String;
		public native function set baselineZero(value:String):void;
		public native function get content():ContentElement;
		public native function set content(value:ContentElement):void;
		public native function get bidiLevel():int;
		public native function set bidiLevel(value:int):void;
		public native function get firstInvalidLine():TextLine;
		public native function get firstLine():TextLine;
		public native function get lastLine():TextLine;
		public native function get textJustifier():TextJustifier;
		public native function set textJustifier(value:TextJustifier):void;
		public native function get textLineCreationResult():String;
		public native function get lineRotation():String;
		public native function set lineRotation(value:String):void;
		public native function get tabStops():Vector.<TabStop>;
		public native function set tabStops(value:Vector.<TabStop>):void;
		public native function findNextAtomBoundary(arg0:int):int;
		public native function findPreviousAtomBoundary(arg0:int):int;
		public native function findNextWordBoundary(arg0:int):int;
		public native function findPreviousWordBoundary(arg0:int):int;
		public native function getTextLineAtCharIndex(arg0:int):TextLine;
		public native function createTextLine(previousLine:TextLine = null, width:Number = 1000000, lineOffset:Number = 0, fitSomething:Boolean = false):TextLine;
		[API("667")]
		public native function recreateTextLine(textLine:TextLine, previousLine:TextLine = null, width:Number = 1000000, lineOffset:Number = 0, fitSomething:Boolean = false):TextLine;
		[API("667")]
		public native function releaseLineCreationData():void;
		public native function releaseLines(start:TextLine, end:TextLine):void;
		public native function dump():String;
	}
}
